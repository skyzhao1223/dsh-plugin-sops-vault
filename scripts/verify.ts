/**
 * Standalone load-path verification against the BUILT artifact (lib/index.js).
 *
 * Mounts the plugin with a fake `webServer` + `shell` context, then drives the
 * captured route handler through meta / reveal / cross-origin-rejection paths
 * and asserts the JSON responses. Proves the published shape (name, inject,
 * Config, apply) survives the build.
 *
 * Run: pnpm build && pnpm verify
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as plugin from '../lib/index.js'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

check('export shape', plugin.name === 'dsh-plugin-vault'
  && Array.isArray(plugin.inject) && plugin.inject.includes('webServer') && plugin.inject.includes('shell')
  && typeof plugin.apply === 'function' && plugin.Config !== undefined)

const commands: string[] = []
let route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> } | null = null
const shell = {
  resolve: (r: { command: string }) => { commands.push(r.command); return r },
  run: async (spec: { command: string }) => {
    if (spec.command.includes("'meta'")) return { exitCode: 0, stdout: { text: '{"a/b":{"url":{"enc":false,"value":"https://x"}}}' }, stderr: { text: '' } }
    if (spec.command.includes("'get'")) return { exitCode: 0, stdout: { text: 'V\n' }, stderr: { text: '' } }
    return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  },
}
const webServer = { register: (r: typeof route) => { route = r; return () => {} } }

plugin.apply({ config: { vaultDir: '/tmp/vault-verify' }, shell, webServer } as never)
check('route registered', route !== null && route.kind === 'prefix' && route.path === '/vault-api')

function mockReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const chunks: Buffer[] = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method, url,
    headers: { host: '127.0.0.1:3080', ...headers },
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
  const res = mockRes()
  await handler(mockReq('GET', '/vault-api/meta'), res)
  const json = JSON.parse(res.body) as { ok: boolean; data?: Record<string, unknown> }
  check('GET meta', res.statusCode === 200 && json.ok === true && json.data?.['a/b'] !== undefined)
}
{
  const res = mockRes()
  await handler(mockReq('POST', '/vault-api/reveal', { name: 'a/b', field: 'password' }), res)
  const json = JSON.parse(res.body) as { ok: boolean; data?: { value?: string } }
  check('POST reveal', json.ok === true && json.data?.value === 'V')
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
check('vault CLI invoked with quoted absolute path', commands.length > 0 && commands[0]!.startsWith(`'/tmp/vault-verify/bin/vault'`))

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('OK: dsh-plugin-vault host half verified')
process.exit(0)
