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
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
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

plugin.apply({ shell, webServer } as never, { vaultDir: dir })
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
function mockRes(): ServerResponse & { statusCode: number; body: string; raw: Buffer; headers: Record<string, string> } {
  return {
    statusCode: 200, body: '', raw: Buffer.alloc(0), headers: {},
    setHeader(k: string, v: string | number) { this.headers[k.toLowerCase()] = String(v) },
    end(s?: string | Buffer) {
      this.raw = Buffer.isBuffer(s) ? s : Buffer.from(s ?? '')
      this.body = Buffer.isBuffer(s) ? '' : (s ?? '')
    },
  } as unknown as ServerResponse & { statusCode: number; body: string; raw: Buffer; headers: Record<string, string> }
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

/**
 * Both DSH shell generations must work. 0.2.0 ships `execution.result` as a
 * METHOD; awaiting it as a property silently yields no exit code and every
 * shell-backed route fails with an empty "exit ?" — so the method shape gets
 * its own mount here, plus the property shape some pre-releases used.
 */
for (const [label, execution] of [
  ['0.2.x result() method', { result: async () => ({ exitCode: 0, stdout: { text: 'V\n' }, stderr: { text: '' } }) }],
  ['0.2.x result promise', { result: Promise.resolve({ exitCode: 0, stdout: { text: 'V\n' }, stderr: { text: '' } }) }],
] as const) {
  let r2: typeof route = null
  const shell2 = {
    resolve: (r: { command: string }) => r,
    execute: async () => execution,
  }
  plugin.apply({ shell: shell2, webServer: { register: (r: typeof route) => { r2 = r; return () => {} } } } as never, { vaultDir: dir })
  const res = mockRes()
  await r2!.handler(mockReq('POST', '/vault-api/reveal', { name: '工作/VPN', field: 'password' }), res)
  const json = JSON.parse(res.body) as ApiResponse
  check(`shell seam ${label}`, json.ok === true && json.data?.value === 'V', res.body.slice(0, 120))
}
{
  // a killed run (null exit code) must say why, not just "exit ?"
  let r3: typeof route = null
  const shell3 = {
    resolve: (r: { command: string }) => r,
    execute: async () => ({ result: async () => ({ exitCode: null, signal: 'SIGKILL', timedOut: true, stdout: { text: '' }, stderr: { text: '' } }) }),
  }
  plugin.apply({ shell: shell3, webServer: { register: (r: typeof route) => { r3 = r; return () => {} } } } as never, { vaultDir: dir })
  const res = mockRes()
  await r3!.handler(mockReq('POST', '/vault-api/reveal', { name: '工作/VPN', field: 'password' }), res)
  const json = JSON.parse(res.body) as ApiResponse
  check('timeout/kill is diagnosed in the error', json.ok === false && /timed out/.test(json.error ?? '') && /SIGKILL/.test(json.error ?? ''), json.error)
}

{
  // totp-batch: ONE decryption yields every code; entries without a seed are reported missing
  let r4: typeof route = null
  const doc = JSON.stringify({ systems: { '工作/VPN': { totp: 'JBSWY3DPEHPK3PXP', password: 'p' }, '服务/npmjs': { totp: '' } } })
  const shell4 = {
    resolve: (r: { command: string }) => { commands.push(r.command); return r },
    run: async () => ({ exitCode: 0, stdout: { text: `${doc}\n` }, stderr: { text: '' } }),
  }
  plugin.apply({ shell: shell4, webServer: { register: (r: typeof route) => { r4 = r; return () => {} } } } as never, { vaultDir: dir })
  const before = commands.length
  const res = mockRes()
  await r4!.handler(mockReq('POST', '/vault-api/totp-batch', { names: ['工作/VPN', '服务/npmjs'] }), res)
  const json = JSON.parse(res.body) as ApiResponse
  const codes = Object.keys(json.data?.codes ?? {})
  check('POST totp-batch in one sops call', json.ok === true && codes.length === 1 && codes[0] === '工作/VPN'
    && /^\d{6}$/.test(String(json.data?.codes?.['工作/VPN']?.code ?? ''))
    && JSON.stringify(json.data?.missing) === JSON.stringify(['服务/npmjs'])
    && commands.length - before === 1, res.body.slice(0, 140))
  check('totp-batch never returns the seed', !res.body.includes('JBSWY3DPEHPK3PXP'))
}

/* ---- logo configuration ---- */
{
  const res = mockRes()
  await handler(mockReq('GET', '/vault-api/logos'), res)
  const json = JSON.parse(res.body) as ApiResponse
  check('GET logos starts empty', json.ok === true && JSON.stringify(json.data?.logos?.groups) === '{}')
}
{
  const res = mockRes()
  await handler(mockReq('POST', '/vault-api/logos', { scope: 'group', key: '工作', logo: '💼' }), res)
  const json = JSON.parse(res.body) as ApiResponse
  check('POST logos sets a group emoji', json.ok === true && json.data?.kind === 'text')
  const res2 = mockRes()
  await handler(mockReq('GET', '/vault-api/logos'), res2)
  check('GET logos reflects the write', (JSON.parse(res2.body) as ApiResponse).data?.logos?.groups?.['工作'] === '💼')
}
{
  const res = mockRes()
  await handler(mockReq('POST', '/vault-api/logos', { scope: 'entry', key: '工作/VPN', logo: 'x.svg' }), res)
  check('svg logo rejected', res.statusCode === 500 && /raster|emoji/i.test((JSON.parse(res.body) as ApiResponse).error ?? ''))
  const res2 = mockRes()
  await handler(mockReq('POST', '/vault-api/logos', { scope: 'group', key: '工作/金山办公', logo: '💼' }), res2)
  check('group scope rejects a 2-segment key', res2.statusCode === 500)
}
{
  // upload a real PNG, then fetch it back through the file route
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const res = mockRes()
  await handler(mockReq('POST', '/vault-api/logo', { name: 'wps.png', dataBase64: png.toString('base64') }), res)
  const json = JSON.parse(res.body) as ApiResponse
  check('POST logo uploads a raster', json.ok === true && json.data?.file === 'wps.png', res.body.slice(0, 120))
  const res2 = mockRes()
  await handler(mockReq('GET', '/vault-api/logo/wps.png'), res2)
  check('GET logo/<name> serves it', res2.statusCode === 200 && res2.headers['content-type'] === 'image/png'
    && res2.raw.length === png.length)
  const res3 = mockRes()
  await handler(mockReq('POST', '/vault-api/logo', { name: 'x.png', dataBase64: Buffer.from('<html><script>alert(1)</script>').toString('base64') }), res3)
  check('non-image upload rejected by magic bytes', res3.statusCode === 500)
  const res4 = mockRes()
  await handler(mockReq('GET', '/vault-api/logo/..%2f..%2fsecrets.yaml'), res4)
  check('logo path traversal refused', res4.statusCode === 404)
}
{
  // a rename carries the logo across (and re-roots keys underneath)
  await handler(mockReq('POST', '/vault-api/logos', { scope: 'entry', key: '工作/VPN', logo: '🔒' }), mockRes())
  const res = mockRes()
  await handler(mockReq('POST', '/vault-api/rename', { name: '工作/VPN', newName: '工作/中化/VPN' }), res)
  const after = JSON.parse(readFileSync(join(dir, 'logos.json'), 'utf8')) as { entries: Record<string, string> }
  check('rename cascades the logo key', (JSON.parse(res.body) as ApiResponse).ok === true
    && after.entries['工作/中化/VPN'] === '🔒' && after.entries['工作/VPN'] === undefined,
  JSON.stringify(after.entries))
}
{
  // deleting an entry drops its logo
  await handler(mockReq('POST', '/vault-api/rm', { name: '工作/中化/VPN' }), mockRes())
  const after = JSON.parse(readFileSync(join(dir, 'logos.json'), 'utf8')) as { entries: Record<string, string> }
  check('entry delete forgets its logo', after.entries['工作/中化/VPN'] === undefined)
}

rmSync(dir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('OK: dsh-plugin-sops-vault host half verified')
process.exit(0)
