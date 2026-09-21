/**
 * Standalone load-path verification against the BUILT artifact (lib/index.js).
 *
 * Mounts the plugin over a fixture vault directory with a fake `webServer` +
 * `shell` context, then drives the captured route handler through the
 * meta / audit / reveal / cross-origin paths and asserts the JSON responses.
 * Proves the published shape (name, inject, Config, apply) survives the build
 * and that meta/audit are served from disk WITHOUT shelling out.
 *
 * Run: pnpm build && pnpm verify
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as plugin from '../lib/index.js'

interface ApiResponse { ok?: boolean; data?: any; error?: string }

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

check('export shape', plugin.name === 'dsh-plugin-sops-vault'
  && Array.isArray(plugin.inject) && plugin.inject.includes('webServer') && plugin.inject.includes('shell')
  && typeof plugin.apply === 'function' && plugin.Config !== undefined)

const ENC = 'ENC[AES256_GCM,data:aaaa,iv:bbbb,tag:cccc,type:str]'
const dir = mkdtempSync(join(tmpdir(), 'vault-verify-'))
writeFileSync(join(dir, 'secrets.yaml'), [
  'systems:',
  '    工作/VPN:',
  '        url: https://vpn.example.com',
  `        password: ${ENC}`,
  'sops:',
  `    mac: ${ENC}`,
  '',
].join('\n'))
writeFileSync(join(dir, '.sops.yaml'), [
  'creation_rules:',
  '  - path_regex: secrets\\.ya?ml$',
  '    age: age1fake',
  "    unencrypted_regex: '(?i)^(url|username|note|env|owner|appid)$'",
  '',
].join('\n'))

const commands: string[] = []
let route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> } | null = null
const shell = {
  resolve: (r: { command: string }) => { commands.push(r.command); return r },
  run: async (spec: { command: string }) => {
    if (spec.command.includes('decrypt')) return { exitCode: 0, stdout: { text: 'V\n' }, stderr: { text: '' } }
    return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  },
}
const webServer = { register: (r: typeof route) => { route = r; return () => {} } }

plugin.apply({ config: { vaultDir: dir }, shell, webServer } as never)
check('route registered', route !== null && route.kind === 'prefix' && route.path === '/vault-api')

function mockReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const chunks: Buffer[] = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method, url,
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  } as unknown as IncomingMessage
}
function mockRes(): ServerResponse & { statusCode: number; body: string } {
  return {
    statusCode: 200, body: '',
    setHeader() {}, end(s?: string) { this.body = s ?? '' },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

const handler = route!.handler

{
  const before = commands.length
  const res = mockRes()
  await handler(mockReq('GET', '/vault-api/meta'), res)
  const json = JSON.parse(res.body) as ApiResponse
  check('GET meta from disk (no shell-out)', res.statusCode === 200 && json.ok === true
    && json.data?.['工作/VPN']?.url?.value === 'https://vpn.example.com'
    && json.data?.['工作/VPN']?.password?.enc === true
    && commands.length === before)
}
{
  const res = mockRes()
  await handler(mockReq('GET', '/vault-api/audit'), res)
  const json = JSON.parse(res.body) as ApiResponse
  check('GET audit', json.ok === true && json.data?.high === 0 && (json.data?.report ?? '').includes('1 encrypted / 1 plaintext'))
}
{
  const res = mockRes()
  await handler(mockReq('POST', '/vault-api/reveal', { name: '工作/VPN', field: 'password' }), res)
  const json = JSON.parse(res.body) as ApiResponse
  check('POST reveal via sops', json.ok === true && json.data?.value === 'V')
}
{
  const res = mockRes()
  await handler(mockReq('GET', '/vault-api/meta', undefined, { origin: 'https://evil.com' }), res)
  check('cross-origin rejected', res.statusCode === 403)
}
{
  const res = mockRes()
  await handler(mockReq('GET', '/vault-api/nope'), res)
  check('unknown route 404', res.statusCode === 404)
}
check('sops invoked with quoted binary and extract path',
  commands.some((c) => c.startsWith(`'sops' 'decrypt' '--extract' '["systems"]["工作/VPN"]["password"]'`)))

rmSync(dir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('OK: dsh-plugin-sops-vault host half verified')
process.exit(0)
