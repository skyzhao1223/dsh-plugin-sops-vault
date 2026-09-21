/**
 * dsh-plugin-vault — node half.
 *
 * Registers one prefix route `/vault-api` on the DSH web server that drives the
 * local `vault` CLI (sops + age + git) of a Vault repository. The browser half
 * (exports["./client"], discovered via the package.json `dsh.client`
 * declaration) renders the sidebar panel and talks to this API same-origin.
 *
 * Security posture:
 * - NO model-facing tools are registered. Agents cannot reach plaintext through
 *   this plugin at all; the vault CLI's own `meta` command (structure only) is
 *   what an agent-side integration should use.
 * - Every request passes an Origin policy (see `isAllowedOrigin`): cross-origin
 *   browser requests are rejected, so a malicious web page cannot drive the
 *   vault even though the server listens on loopback.
 * - Plaintext secret values cross the API only for `reveal`/`totp`, which the
 *   panel calls on an explicit human click.
 *
 * @module dsh-plugin-vault
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  API_PATH,
  asString,
  isAllowedOrigin,
  parseTotpOutput,
  quote,
  subPath,
  validateEntryName,
  validateFieldName,
  vaultCommand,
} from './host/vault.ts'
import type { ShellLike, VaultPluginConfig, WebServerLike } from './host/types.ts'

/** Cordis function-plugin name. */
export const name = 'dsh-plugin-vault'

/** Hard dependencies: the web carrier and the bash execution service. */
export const inject = ['webServer', 'shell']

/** Row config: where the vault lives and how long commands may run.
 *  schemastery fields are optional unless `.required()`; see VaultPluginConfig. */
export const Config = z.object({
  vaultDir: z.string(),
  vaultBin: z.string(),
  timeoutMs: z.number().step(1).min(1000).max(120000),
})

function resolveDir(configured: string | undefined): string {
  const raw = configured ?? '~/Vault'
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

function send(res: ServerResponse, code: number, payload: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(JSON.stringify(payload))
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed as Record<string, unknown>
}

/**
 * Mount the `/vault-api` route. Disposal of this plugin fiber unregisters it.
 * @param ctx - root context providing `webServer` and `shell`.
 */
export function apply(ctx: Context): void {
  const config = (ctx as unknown as { config?: VaultPluginConfig }).config ?? {}
  const vaultDir = resolveDir(config.vaultDir)
  const vaultBin = config.vaultBin ?? join(vaultDir, 'bin', 'vault')
  const timeoutMs = config.timeoutMs ?? 15_000
  const { shell, webServer } = ctx as unknown as { shell: ShellLike; webServer: WebServerLike }

  async function runVault(args: readonly string[], ms = timeoutMs): Promise<string> {
    const spec = shell.resolve({ command: vaultCommand(vaultBin, args), workdir: vaultDir, timeoutMs: ms })
    const r = await shell.run(spec)
    const out = typeof r?.stdout?.text === 'string' ? r.stdout.text : ''
    const err = typeof r?.stderr?.text === 'string' ? r.stderr.text : ''
    if (r?.exitCode !== 0) {
      throw new Error(`vault ${String(args[0])} failed (exit ${String(r?.exitCode ?? '?')}): ${(err || out).slice(0, 300)}`)
    }
    return out
  }

  async function runRaw(command: string, ms = 8000): Promise<string> {
    const spec = shell.resolve({ command, workdir: vaultDir, timeoutMs: ms })
    const r = await shell.run(spec)
    return typeof r?.stdout?.text === 'string' ? r.stdout.text : ''
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
        send(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
      const route = subPath(req.url ?? '')
      const method = req.method ?? 'GET'

      if (method === 'GET') {
        if (route === 'meta') {
          const data: unknown = JSON.parse(await runVault(['meta']))
          send(res, 200, { ok: true, data: data && typeof data === 'object' ? data : {} })
          return
        }
        if (route === 'audit') {
          send(res, 200, { ok: true, data: { report: await runVault(['audit'], 30_000) } })
          return
        }
        if (route === 'dirty') {
          const out = await runRaw(`git -C ${quote(vaultDir)} status --porcelain`)
          send(res, 200, { ok: true, data: { dirty: out.trim() !== '' } })
          return
        }
      }

      if (method === 'POST') {
        const body = await readBody(req)

        if (route === 'reveal') {
          if (!validateEntryName(body.name)) throw new Error('reveal: invalid name')
          const field = body.field === undefined ? 'password' : body.field
          if (!validateFieldName(field)) throw new Error('reveal: invalid field')
          const out = await runVault(['get', body.name, field])
          send(res, 200, { ok: true, data: { value: out.replace(/\n+$/, '') } })
          return
        }
        if (route === 'totp') {
          if (!validateEntryName(body.name)) throw new Error('totp: invalid name')
          const parsed = parseTotpOutput(await runVault(['totp', body.name]))
          if (!parsed) throw new Error('totp: unparseable output')
          send(res, 200, { ok: true, data: parsed })
          return
        }
        if (route === 'set') {
          if (!validateEntryName(body.name)) throw new Error('set: invalid name')
          if (!validateFieldName(body.field)) throw new Error('set: invalid field')
          const value = asString(body.value, 16 * 1024)
          if (value === null) throw new Error('set: invalid value')
          await runVault(['set', body.name, body.field, value], 20_000)
          send(res, 200, { ok: true, data: { saved: `${body.name}.${body.field}` } })
          return
        }
        if (route === 'rm') {
          if (!validateEntryName(body.name)) throw new Error('rm: invalid name')
          const field = body.field === undefined || body.field === '' ? null : body.field
          if (field !== null && !validateFieldName(field)) throw new Error('rm: invalid field')
          await runVault(field === null ? ['rm', body.name] : ['rm', body.name, field])
          send(res, 200, { ok: true, data: { removed: field === null ? body.name : `${body.name}.${field}` } })
          return
        }
        if (route === 'create') {
          if (!validateEntryName(body.name)) throw new Error('create: invalid name')
          const cmd = ['new', String(body.name).trim()]
          for (const key of ['url', 'username', 'note'] as const) {
            const v = asString(body[key], 2000)
            if (v !== null && v !== '') cmd.push(`--${key}`, v)
          }
          const out = await runVault(cmd, 20_000)
          send(res, 200, { ok: true, data: { created: String(body.name).trim(), msg: out.replace(/\n+$/, '') } })
          return
        }
        if (route === 'save') {
          const msg = asString(body.msg, 200) ?? 'vault panel changes'
          const out = await runVault(['save', msg], 20_000)
          send(res, 200, { ok: true, data: { msg: out.split('\n')[0] ?? '' } })
          return
        }
      }

      send(res, 404, { ok: false, error: `unknown route: ${method} ${route}` })
    } catch (error) {
      send(res, 500, { ok: false, error: String((error as Error | undefined)?.message ?? error).slice(0, 300) })
    }
  }

  webServer.register({ kind: 'prefix', path: API_PATH, handler: handle })
}
