/**
 * Host-half tests: pure vault logic (inline sops implementation) plus full
 * route dispatch against a fixture vault directory and a fake shell/webServer.
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import {
  API_PATH, asString, auditLine, auditVault, base32Decode, genPassword,
  isAllowedOrigin, looksLikeSecret, parseAllowRegex, parseRawVault, quote,
  sopsPath, subPath, totpFromSeed, validateEntryName, validateFieldName,
} from '../src/host/vault.ts'

/* ---------------- pure helpers ---------------- */

describe('shell helpers', () => {
  it('quote escapes single quotes POSIX-style', () => {
    expect(quote('plain')).toBe(`'plain'`)
    expect(quote(`a'b`)).toBe(`'a'\\''b'`)
    expect(quote('工作/公司 VPN')).toBe(`'工作/公司 VPN'`)
  })

  it('sopsPath builds chained bracket groups, not a JSON array', () => {
    expect(sopsPath(['systems', '工作/VPN', 'password'])).toBe('["systems"]["工作/VPN"]["password"]')
    expect(sopsPath([`a"b`])).toBe('["a\\"b"]')
  })
})

describe('request policy', () => {
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

/* ---------------- vault parsing + audit ---------------- */

const ENC = 'ENC[AES256_GCM,data:aaaa,iv:bbbb,tag:cccc,type:str]'
const FIXTURE_SECRETS = `# comment line
systems:
    工作/VPN:
        url: https://vpn.example.com
        username: zhangsan
        password: ${ENC}
        totp: ${ENC}
        note: ""
    服务/支付:
        appid: wx8888888888888888
        apiv3_key: ${ENC}
sops:
    mac: ${ENC}
`
const FIXTURE_SOPS_YAML = `creation_rules:
  - path_regex: secrets\\.ya?ml$
    age: age1fakefakefakefakefakefakefakefakefakefakefake
    unencrypted_regex: '(?i)^(url|username|note|env|owner|appid)$'
`

describe('parseRawVault', () => {
  it('reads structure without decryption', () => {
    const meta = parseRawVault(FIXTURE_SECRETS)
    expect(Object.keys(meta)).toEqual(['工作/VPN', '服务/支付'])
    expect(meta['工作/VPN']!.url).toEqual({ enc: false, value: 'https://vpn.example.com' })
    expect(meta['工作/VPN']!.password).toEqual({ enc: true })
    expect(meta['工作/VPN']!.note).toEqual({ enc: false, value: '' })
    expect(meta['服务/支付']!.appid).toEqual({ enc: false, value: 'wx8888888888888888' })
  })

  it('stops at the sops metadata block', () => {
    expect(parseRawVault(FIXTURE_SECRETS)['sops']).toBeUndefined()
  })
})

describe('parseAllowRegex', () => {
  it('translates the Go-style (?i) inline flag and lists names', () => {
    const rule = parseAllowRegex(FIXTURE_SOPS_YAML)
    expect(rule).not.toBeNull()
    expect(rule!.rx.test('URL')).toBe(true)
    expect(rule!.rx.test('password')).toBe(false)
    expect(rule!.names).toEqual(['url', 'username', 'note', 'env', 'owner', 'appid'])
  })

  it('returns null when the allowlist is missing', () => {
    expect(parseAllowRegex('creation_rules: []\n')).toBeNull()
  })
})

describe('auditVault', () => {
  it('clean vault: no high findings', () => {
    const r = auditVault(FIXTURE_SECRETS, FIXTURE_SOPS_YAML)
    expect(r.findings.filter((f) => f.level === 'high')).toHaveLength(0)
    expect(r.report).toContain('fields: 3 encrypted / 4 plaintext (2 entries)')
  })

  it('flags plaintext fields outside the allowlist as high', () => {
    const leaked = FIXTURE_SECRETS.replace(`        apiv3_key: ${ENC}`, `        apikey: PLAIN_LEAK_12345678\n        apiv3_key: ${ENC}`)
    const r = auditVault(leaked, FIXTURE_SOPS_YAML)
    const highs = r.findings.filter((f) => f.level === 'high')
    expect(highs.length).toBeGreaterThan(0)
    expect(highs.some((f) => f.field === 'apikey')).toBe(true)
  })

  it('flags a sensitive name inside the allowlist as high', () => {
    const badRule = FIXTURE_SOPS_YAML.replace('appid)$', 'appid|access_token)$')
    const r = auditVault(FIXTURE_SECRETS, badRule)
    expect(r.findings.some((f) => f.level === 'high' && f.field === 'access_token')).toBe(true)
  })

  it('warns when an allowlisted value looks like a credential', () => {
    const r = auditVault(FIXTURE_SECRETS, FIXTURE_SOPS_YAML)
    expect(r.findings.some((f) => f.level === 'warn' && f.field === 'appid')).toBe(true)
  })

  it('flags a missing allowlist entirely', () => {
    const r = auditVault(FIXTURE_SECRETS, 'creation_rules: []\n')
    expect(r.findings.some((f) => f.level === 'high' && f.detail.includes('allowlist'))).toBe(true)
  })
})

describe('looksLikeSecret', () => {
  it('catches prefixed keys and high-entropy strings, skips paths and prose', () => {
    expect(looksLikeSecret('sk-live-abcdef123456')).toBe(true)
    expect(looksLikeSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true)
    expect(looksLikeSecret('kU1iDyNbeuEHV6vEKgmSIrpf')).toBe(true)
    expect(looksLikeSecret('/Users/me/certs/a.p12')).toBe(false)
    expect(looksLikeSecret('https://example.com/x')).toBe(false)
    expect(looksLikeSecret('需先连办公网，短信验证')).toBe(false)
    expect(looksLikeSecret('short1')).toBe(false)
  })
})

/* ---------------- crypto ---------------- */

describe('totp', () => {
  it('base32 decodes the RFC 4648 vector', () => {
    expect(Buffer.from(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toString('ascii')).toBe('12345678901234567890')
  })

  it('matches the RFC 6238 SHA-1 vector at T=59 (6-digit truncation)', () => {
    const r = totpFromSeed('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)
    expect(r).not.toBeNull()
    expect(r!.code).toBe('287082') // RFC value 94287082 mod 10^6
    expect(r!.remain).toBe(1)
  })

  it('rotates at the 30s boundary', () => {
    const a = totpFromSeed('JBSWY3DPEHPK3PXP', 60_000)!
    const b = totpFromSeed('JBSWY3DPEHPK3PXP', 90_000)!
    expect(a.code).not.toBe(b.code)
    expect(b.remain).toBe(30)
  })

  it('rejects unusable seeds', () => {
    expect(totpFromSeed('')).toBeNull()
    expect(totpFromSeed('!!!!')).toBeNull()
  })
})

describe('genPassword', () => {
  it('generates 24 chars from the safe alphabet, unique per call', () => {
    const p = genPassword()
    expect(p).toHaveLength(24)
    expect(/^[A-Za-z0-9!@#%^_+=-]+$/.test(p)).toBe(true)
    expect(genPassword()).not.toBe(p)
  })
})

describe('auditLine', () => {
  it('logs action/target/source and never a value', () => {
    expect(auditLine('reveal', '工作/VPN.password', '127.0.0.1', new Date(0)))
      .toBe('1970-01-01T00:00:00.000Z reveal 工作/VPN.password src=127.0.0.1')
  })
})

/* ---------------- route dispatch against a fixture ---------------- */

interface CapturedRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

let dir = ''
const commands: string[] = []
const captured: CapturedRoute[] = []

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-plugin-test-'))
  writeFileSync(join(dir, 'secrets.yaml'), FIXTURE_SECRETS)
  writeFileSync(join(dir, '.sops.yaml'), FIXTURE_SOPS_YAML)
  mkdirSync(join(dir, '.git')) // exercise the .git/ audit-log location
  const shell = {
    resolve: (r: { command: string }) => { commands.push(r.command); return r },
    run: async (spec: { command: string }) => {
      if (spec.command.includes('decrypt') && spec.command.includes('"totp"')) {
        return { exitCode: 0, stdout: { text: 'JBSWY3DPEHPK3PXP\n' }, stderr: { text: '' } }
      }
      if (spec.command.includes('decrypt')) {
        return { exitCode: 0, stdout: { text: 'SECRET-VALUE\n' }, stderr: { text: '' } }
      }
      if (spec.command.includes('--porcelain')) {
        return { exitCode: 0, stdout: { text: ' M secrets.yaml\n' }, stderr: { text: '' } }
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    },
  }
  const webServer = { register: (route: CapturedRoute) => { captured.push(route); return () => {} } }
  plugin.apply({ shell, webServer } as unknown as Context, { vaultDir: dir })
})

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function mockReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const chunks: Buffer[] = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method, url,
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  } as unknown as IncomingMessage
}

interface TestRes extends ServerResponse { body: string; json: () => { ok: boolean; data?: any; error?: string } }
function mockRes(): TestRes {
  const res = {
    statusCode: 200, body: '',
    setHeader() {}, end(s?: string) { this.body = s ?? '' },
    json() { return JSON.parse(this.body) },
  }
  return res as unknown as TestRes
}

const call = async (req: IncomingMessage): Promise<TestRes> => {
  const res = mockRes()
  await captured[0]!.handler(req, res)
  return res
}

describe('route dispatch', () => {
  it('registers one prefix route at /vault-api', () => {
    expect(captured).toHaveLength(1)
    expect(captured[0]!.kind).toBe('prefix')
    expect(captured[0]!.path).toBe(API_PATH)
  })

  it('GET meta parses the fixture WITHOUT any shell-out', async () => {
    const before = commands.length
    const res = await call(mockReq('GET', `${API_PATH}/meta`))
    const json = res.json()
    expect(json.ok).toBe(true)
    expect(json.data['工作/VPN'].url.value).toBe('https://vpn.example.com')
    expect(json.data['工作/VPN'].password).toEqual({ enc: true })
    expect(commands).toHaveLength(before)
  })

  it('GET audit reports encrypted/plaintext counts', async () => {
    const res = await call(mockReq('GET', `${API_PATH}/audit`))
    const json = res.json()
    expect(json.ok).toBe(true)
    expect(json.data.report).toContain('3 encrypted / 4 plaintext')
  })

  it('POST reveal extracts via sops and writes the access log (never the value)', async () => {
    const res = await call(mockReq('POST', `${API_PATH}/reveal`, { name: '工作/VPN', field: 'password' }))
    expect(res.json().data.value).toBe('SECRET-VALUE')
    const logFile = join(dir, '.git', 'dsh-vault-audit.log')
    expect(existsSync(logFile)).toBe(true)
    const log = readFileSync(logFile, 'utf8')
    expect(log).toContain('reveal 工作/VPN.password')
    expect(log).not.toContain('SECRET-VALUE')
  })

  it('POST totp computes a live code from the extracted seed', async () => {
    const res = await call(mockReq('POST', `${API_PATH}/totp`, { name: '工作/VPN' }))
    const d = res.json().data
    expect(d.code).toMatch(/^\d{6}$/)
    expect(d.remain).toBeGreaterThan(0)
    expect(d.remain).toBeLessThanOrEqual(30)
  })

  it('GET dirty reflects git status', async () => {
    const res = await call(mockReq('GET', `${API_PATH}/dirty`))
    expect(res.json().data.dirty).toBe(true)
  })

  it('GET audit-log returns recent lines', async () => {
    const res = await call(mockReq('GET', `${API_PATH}/audit-log`))
    const d = res.json().data
    expect(Array.isArray(d.lines)).toBe(true)
    expect(d.lines.some((l: string) => l.includes('reveal'))).toBe(true)
  })

  it('POST create generates a password and never returns it', async () => {
    const before = commands.length
    const res = await call(mockReq('POST', `${API_PATH}/create`, { name: '测试/新建', url: 'https://x', note: 'n' }))
    const d = res.json().data
    expect(d.created).toBe('测试/新建')
    expect(d.passwordGenerated).toBe(true)
    const sets = commands.slice(before).filter((c) => c.includes("'set'"))
    expect(sets.length).toBe(8) // url username note env owner password totp token
  })

  it('POST rename validates existence/conflicts and runs the round trip', async () => {
    const before = commands.length
    const ok = await call(mockReq('POST', `${API_PATH}/rename`, { name: '服务/支付', newName: '服务/支付2' }))
    expect(ok.json().data.renamed).toBe('服务/支付2')
    const roundtripCmd = commands.slice(before).find((c) => c.includes('--filename-override')) ?? ''
    expect(roundtripCmd).toContain('| jq ')
    expect(roundtripCmd).toContain('mv')

    const missing = await call(mockReq('POST', `${API_PATH}/rename`, { name: '没有这个', newName: 'x/y' }))
    expect(missing.statusCode).toBe(500)
    expect(missing.json().error).toContain('not found')

    const clash = await call(mockReq('POST', `${API_PATH}/rename`, { name: '服务/支付', newName: '工作/VPN' }))
    expect(clash.statusCode).toBe(500)
    expect(clash.json().error).toContain('exists')
  })

  it('POST sort runs the whole-file round trip', async () => {
    const res = await call(mockReq('POST', `${API_PATH}/sort`))
    expect(res.json()).toEqual({ ok: true, data: { sorted: true } })
  })

  it('rejects cross-origin requests with 403 before touching sops', async () => {
    const before = commands.length
    const res = await call(mockReq('POST', `${API_PATH}/reveal`, { name: '工作/VPN' }, { origin: 'https://evil.com' }))
    expect(res.statusCode).toBe(403)
    expect(commands).toHaveLength(before)
  })

  it('404s unknown routes', async () => {
    const res = await call(mockReq('GET', `${API_PATH}/bogus`))
    expect(res.statusCode).toBe(404)
  })

  it('rate-limits plaintext endpoints (429 after 30/min)', async () => {
    let sawLimit = false
    for (let i = 0; i < 45; i++) {
      const res = mockRes()
      await captured[0]!.handler(mockReq('POST', `${API_PATH}/reveal`, { name: '工作/VPN', field: 'password' }), res)
      if (res.statusCode === 429) { sawLimit = true; break }
    }
    expect(sawLimit).toBe(true)
  })

  it('rejects invalid identifiers', async () => {
    const res = await call(mockReq('POST', `${API_PATH}/set`, { name: 'ok', field: 'bad field', value: 'v' }))
    expect(res.statusCode).toBe(500)
    expect(res.json().ok).toBe(false)
  })
})

describe('plugin export shape', () => {
  it('exports the cordis function-plugin contract', () => {
    expect(plugin.name).toBe('dsh-plugin-sops-vault')
    expect(plugin.inject).toEqual(['webServer', 'shell'])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.Config).toBeDefined()
  })
})
