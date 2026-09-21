/**
 * Host-half tests: pure helpers plus full route dispatch against a fake
 * shell/webServer context (no real vault, no real HTTP).
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import {
  API_PATH, asString, isAllowedOrigin, parseTotpOutput, quote, subPath,
  validateEntryName, validateFieldName, vaultCommand,
} from '../src/host/vault.ts'

describe('pure helpers', () => {
  it('quote escapes single quotes POSIX-style', () => {
    expect(quote('plain')).toBe(`'plain'`)
    expect(quote(`a'b`)).toBe(`'a'\\''b'`)
    expect(quote('工作/公司 VPN')).toBe(`'工作/公司 VPN'`)
  })

  it('vaultCommand quotes every argument', () => {
    expect(vaultCommand('/bin/v', ['get', `a'b`])).toBe(`'/bin/v' 'get' 'a'\\''b'`)
  })

  it('parseTotpOutput reads code and remaining seconds', () => {
    expect(parseTotpOutput('123456   剩余 27s\n')).toEqual({ code: '123456', remain: 27 })
    expect(parseTotpOutput('033300 14s')).toEqual({ code: '033300', remain: 14 })
    expect(parseTotpOutput('garbage')).toBeNull()
  })

  it('isAllowedOrigin blocks cross-origin and null, allows same-origin and non-browser', () => {
    expect(isAllowedOrigin(undefined, '127.0.0.1:3080')).toBe(true)
    expect(isAllowedOrigin('', '127.0.0.1:3080')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:3080', '127.0.0.1:3080')).toBe(true)
    expect(isAllowedOrigin('https://evil.com', '127.0.0.1:3080')).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:9999', '127.0.0.1:3080')).toBe(false)
    expect(isAllowedOrigin('null', '127.0.0.1:3080')).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:3080', undefined)).toBe(false)
  })

  it('validateEntryName accepts grouped CJK names, rejects control chars and blanks', () => {
    expect(validateEntryName('工作/公司VPN')).toBe(true)
    expect(validateEntryName('')).toBe(false)
    expect(validateEntryName(' lead')).toBe(false)
    expect(validateEntryName('a\u0000b')).toBe(false)
    expect(validateEntryName(123)).toBe(false)
    expect(validateEntryName('x'.repeat(201))).toBe(false)
  })

  it('validateFieldName rejects YAML-hostile characters', () => {
    expect(validateFieldName('apiv3_key')).toBe(true)
    expect(validateFieldName('a b')).toBe(false)
    expect(validateFieldName('a:b')).toBe(false)
    expect(validateFieldName(`a'b`)).toBe(false)
    expect(validateFieldName('')).toBe(false)
  })

  it('subPath strips prefix and query', () => {
    expect(subPath(`${API_PATH}/meta?x=1`)).toBe('meta')
    expect(subPath(API_PATH)).toBe('')
  })

  it('asString clamps and rejects control characters', () => {
    expect(asString('ok')).toBe('ok')
    expect(asString('a\u0001b')).toBeNull()
    expect(asString('x'.repeat(5000), 4096)).toBeNull()
    expect(asString(42)).toBeNull()
  })
})

/* ---------- route dispatch against fakes ---------- */

interface CapturedRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

function mount() {
  const commands: string[] = []
  const captured: CapturedRoute[] = []
  const shell = {
    resolve: (r: { command: string }) => { commands.push(r.command); return r },
    run: async (spec: { command: string }) => {
      if (spec.command.includes("'meta'")) {
        return { exitCode: 0, stdout: { text: '{"工作/VPN":{"url":{"enc":false,"value":"https://x"}}}' }, stderr: { text: '' } }
      }
      if (spec.command.includes("'get'")) {
        return { exitCode: 0, stdout: { text: 'SECRET-VALUE\n' }, stderr: { text: '' } }
      }
      if (spec.command.includes("'totp'")) {
        return { exitCode: 0, stdout: { text: '654321   剩余 12s' }, stderr: { text: '' } }
      }
      if (spec.command.includes('status --porcelain')) {
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      }
      return { exitCode: 0, stdout: { text: 'ok\n' }, stderr: { text: '' } }
    },
  }
  const webServer = {
    register: (route: CapturedRoute) => { captured.push(route); return () => {} },
  }
  const ctx = { config: { vaultDir: '/tmp/vault-test' }, shell, webServer } as unknown as Context
  plugin.apply(ctx)
  return { commands, captured }
}

function mockReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const chunks: Buffer[] = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
  return req as unknown as IncomingMessage
}

function mockRes(): ServerResponse & { code: number; body: string; json: () => { ok: boolean; data?: unknown; error?: string } } {
  const res = {
    statusCode: 200,
    body: '',
    setHeader() { /* ignored */ },
    end(s?: string) { this.body = s ?? '' },
    get code() { return this.statusCode },
    json() { return JSON.parse(this.body) as { ok: boolean; data?: unknown; error?: string } },
  }
  return res as unknown as ServerResponse & { code: number; body: string; json: () => { ok: boolean; data?: unknown; error?: string } }
}

describe('route dispatch', () => {
  it('registers one prefix route at /vault-api', () => {
    const { captured } = mount()
    expect(captured).toHaveLength(1)
    expect(captured[0]!.kind).toBe('prefix')
    expect(captured[0]!.path).toBe(API_PATH)
  })

  it('GET meta returns parsed structure and runs the vault CLI', async () => {
    const { captured, commands } = mount()
    const res = mockRes()
    await captured[0]!.handler(mockReq('GET', `${API_PATH}/meta`), res)
    expect(res.json()).toEqual({ ok: true, data: { '工作/VPN': { url: { enc: false, value: 'https://x' } } } })
    expect(commands.some((c) => c.includes('meta'))).toBe(true)
  })

  it('POST reveal strips the trailing newline', async () => {
    const { captured } = mount()
    const res = mockRes()
    await captured[0]!.handler(mockReq('POST', `${API_PATH}/reveal`, { name: '工作/VPN', field: 'password' }), res)
    expect(res.json()).toEqual({ ok: true, data: { value: 'SECRET-VALUE' } })
  })

  it('POST totp parses code and remain', async () => {
    const { captured } = mount()
    const res = mockRes()
    await captured[0]!.handler(mockReq('POST', `${API_PATH}/totp`, { name: '工作/VPN' }), res)
    expect(res.json()).toEqual({ ok: true, data: { code: '654321', remain: 12 } })
  })

  it('rejects cross-origin requests with 403 before touching the vault', async () => {
    const { captured, commands } = mount()
    const res = mockRes()
    await captured[0]!.handler(mockReq('GET', `${API_PATH}/meta`, undefined, { origin: 'https://evil.com' }), res)
    expect(res.statusCode).toBe(403)
    expect(commands).toHaveLength(0)
  })

  it('accepts same-origin browser requests', async () => {
    const { captured } = mount()
    const res = mockRes()
    await captured[0]!.handler(mockReq('GET', `${API_PATH}/meta`, undefined, { origin: 'http://127.0.0.1:3080' }), res)
    expect(res.json().ok).toBe(true)
  })

  it('404s unknown routes', async () => {
    const { captured } = mount()
    const res = mockRes()
    await captured[0]!.handler(mockReq('GET', `${API_PATH}/bogus`), res)
    expect(res.statusCode).toBe(404)
  })

  it('rejects invalid identifiers with an error payload', async () => {
    const { captured } = mount()
    const res = mockRes()
    await captured[0]!.handler(mockReq('POST', `${API_PATH}/set`, { name: 'ok', field: 'bad field', value: 'v' }), res)
    expect(res.statusCode).toBe(500)
    expect(res.json().ok).toBe(false)
  })

  it('GET dirty reports clean tree', async () => {
    const { captured } = mount()
    const res = mockRes()
    await captured[0]!.handler(mockReq('GET', `${API_PATH}/dirty`), res)
    expect(res.json()).toEqual({ ok: true, data: { dirty: false } })
  })
})

describe('plugin export shape', () => {
  it('exports the cordis function-plugin contract', () => {
    expect(plugin.name).toBe('dsh-plugin-vault')
    expect(plugin.inject).toEqual(['webServer', 'shell'])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.Config).toBeDefined()
  })
})
