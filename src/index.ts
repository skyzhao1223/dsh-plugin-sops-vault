/**
 * dsh-plugin-sops-vault — node half.
 *
 * Registers one prefix route `/vault-api` on the DSH web server that drives a
 * local sops+age+git vault repository DIRECTLY (shelling out only to the
 * `sops` and `git` binaries; no external `vault` CLI dependency). The browser
 * half (exports["./client"], discovered via the package.json `dsh.client`
 * declaration) renders the sidebar panel and talks to this API same-origin.
 *
 * Security posture:
 * - NO model-facing tools are registered. Agents cannot reach plaintext through
 *   this plugin at all.
 * - Every request passes an Origin policy (see `isAllowedOrigin`): cross-origin
 *   browser requests are rejected, so a malicious web page cannot drive the
 *   vault even though the server listens on loopback.
 * - Plaintext secret values cross the API only for `reveal`/`totp`, which the
 *   panel calls on an explicit human click.
 * - Every plaintext read and every write is appended to an access log that
 *   NEVER contains values (`.git/dsh-vault-audit.log`, or `<vaultDir>/.audit.log`
 *   when the vault is not a git repo — kept out of git so the dirty state is
 *   unaffected).
 *
 * @module dsh-plugin-sops-vault
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  API_PATH,
  asString,
  auditLine,
  auditVault,
  genPassword,
  isAllowedOrigin,
  parseRawVault,
  quote,
  sopsPath,
  subPath,
  totpFromSeed,
  validateEntryName,
  validateFieldName,
} from './host/vault.ts'
import type { ShellLike, VaultPluginConfig, WebServerLike } from './host/types.ts'

/** Cordis function-plugin name. */
export const name = 'dsh-plugin-sops-vault'

/** Hard dependencies: the web carrier and the bash execution service. */
export const inject = ['webServer', 'shell']

/** Row config: where the vault lives and which binaries to use. */
export const Config = z.object({
  vaultDir: z.string(),
  sopsBin: z.string(),
  gitBin: z.string(),
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
 * @param config - row config, validated against {@link Config} and passed by
 *   the Cordis fiber as apply's second argument (NOT `ctx.config` — the Guard
 *   rejects undeclared context property access).
 */
export function apply(ctx: Context, config?: VaultPluginConfig): void {
  const cfg = config ?? {}
  const vaultDir = resolveDir(cfg.vaultDir)
  const sopsBin = cfg.sopsBin ?? 'sops'
  const gitBin = cfg.gitBin ?? 'git'
  const timeoutMs = cfg.timeoutMs ?? 15_000
  const secretsFile = join(vaultDir, 'secrets.yaml')
  const sopsConfigFile = join(vaultDir, '.sops.yaml')
  const logFile = existsSync(join(vaultDir, '.git'))
    ? join(vaultDir, '.git', 'dsh-vault-audit.log')
    : join(vaultDir, '.audit.log')
  const { shell, webServer } = ctx as unknown as { shell: ShellLike; webServer: WebServerLike }

  async function run(command: string, ms = timeoutMs): Promise<string> {
    const spec = shell.resolve({ command, workdir: vaultDir, timeoutMs: ms })
    const r = await shell.run(spec)
    const out = typeof r?.stdout?.text === 'string' ? r.stdout.text : ''
    const err = typeof r?.stderr?.text === 'string' ? r.stderr.text : ''
    if (r?.exitCode !== 0) {
      throw new Error(`command failed (exit ${String(r?.exitCode ?? '?')}): ${(err || out).slice(0, 300)}`)
    }
    return out
  }

  async function runOk(command: string, ms = timeoutMs): Promise<number | null> {
    const spec = shell.resolve({ command, workdir: vaultDir, timeoutMs: ms })
    const r = await shell.run(spec)
    return r?.exitCode ?? null
  }

  /** sops sub-invocation against the vault's secrets file. */
  const sops = (args: readonly string[], ms?: number): Promise<string> =>
    run([quote(sopsBin), ...args.map(quote)].join(' '), ms)

  const git = (args: readonly string[], ms?: number): Promise<string> =>
    run([quote(gitBin), ...args.map(quote)].join(' '), ms)

  /**
   * Sliding-window rate limit for plaintext-returning endpoints (reveal/totp).
   * A human clicks at most a few per minute; a scripted burst (e.g. XSS inside
   * the GUI scraping every secret) hits the ceiling immediately. In-memory per
   * mount — deliberately not persisted.
   */
  const REVEAL_LIMIT = 30
  const REVEAL_WINDOW_MS = 60_000
  const revealTimes: number[] = []
  function allowReveal(): boolean {
    const now = Date.now()
    while (revealTimes.length > 0 && now - (revealTimes[0] ?? 0) > REVEAL_WINDOW_MS) revealTimes.shift()
    if (revealTimes.length >= REVEAL_LIMIT) return false
    revealTimes.push(now)
    return true
  }

  function log(action: string, target: string, req: IncomingMessage): void {
    try {
      appendFileSync(logFile, `${auditLine(action, target, req.socket?.remoteAddress ?? '?')}\n`)
    } catch {
      /* logging must never fail a request */
    }
  }

  function readSecretsRaw(): string {
    if (!existsSync(secretsFile)) throw new Error(`vault not found: ${secretsFile} (set config.vaultDir)`)
    return readFileSync(secretsFile, 'utf8')
  }

  async function extractField(name: string, field: string): Promise<string> {
    const out = await sops(['decrypt', '--extract', sopsPath(['systems', name, field]), secretsFile])
    return out.replace(/\n+$/, '')
  }

  async function setField(name: string, field: string, value: string): Promise<void> {
    await sops(['set', '--idempotent', secretsFile, sopsPath(['systems', name, field]), JSON.stringify(value)], 20_000)
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
          send(res, 200, { ok: true, data: parseRawVault(readSecretsRaw()) })
          return
        }
        if (route === 'audit') {
          const sopsYaml = existsSync(sopsConfigFile) ? readFileSync(sopsConfigFile, 'utf8') : ''
          const result = auditVault(readSecretsRaw(), sopsYaml)
          send(res, 200, { ok: true, data: { report: result.report, high: result.findings.filter((f) => f.level === 'high').length } })
          return
        }
        if (route === 'audit-log') {
          let lines: string[] = []
          try {
            lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-200)
          } catch { /* no log yet */ }
          send(res, 200, { ok: true, data: { file: logFile, lines } })
          return
        }
        if (route === 'dirty') {
          const out = await git(['-C', vaultDir, 'status', '--porcelain'])
          send(res, 200, { ok: true, data: { dirty: out.trim() !== '' } })
          return
        }
      }

      if (method === 'POST') {
        const body = await readBody(req)

        if (route === 'reveal') {
          if (!allowReveal()) {
            send(res, 429, { ok: false, error: 'reveal rate limit exceeded (30/min); if this was not you, treat the GUI as compromised' })
            return
          }
          if (!validateEntryName(body.name)) throw new Error('reveal: invalid name')
          const field = body.field === undefined ? 'password' : body.field
          if (!validateFieldName(field)) throw new Error('reveal: invalid field')
          const value = await extractField(body.name, field)
          log('reveal', `${body.name}.${field}`, req)
          send(res, 200, { ok: true, data: { value } })
          return
        }
        if (route === 'totp') {
          if (!allowReveal()) {
            send(res, 429, { ok: false, error: 'totp rate limit exceeded (30/min shared with reveal)' })
            return
          }
          if (!validateEntryName(body.name)) throw new Error('totp: invalid name')
          const seed = await extractField(body.name, 'totp')
          const result = seed ? totpFromSeed(seed) : null
          if (!result) throw new Error('totp: no usable seed stored for this entry')
          log('totp', body.name, req)
          send(res, 200, { ok: true, data: result })
          return
        }
        if (route === 'set') {
          if (!validateEntryName(body.name)) throw new Error('set: invalid name')
          if (!validateFieldName(body.field)) throw new Error('set: invalid field')
          const value = asString(body.value, 16 * 1024)
          if (value === null) throw new Error('set: invalid value')
          await setField(body.name, body.field, value)
          log('set', `${body.name}.${body.field}`, req)
          send(res, 200, { ok: true, data: { saved: `${body.name}.${body.field}` } })
          return
        }
        if (route === 'rm') {
          if (!validateEntryName(body.name)) throw new Error('rm: invalid name')
          const field = body.field === undefined || body.field === '' ? null : body.field
          if (field !== null && !validateFieldName(field)) throw new Error('rm: invalid field')
          await sops(['unset', '--idempotent', secretsFile, sopsPath(field === null ? ['systems', body.name] : ['systems', body.name, field])])
          log('rm', field === null ? body.name : `${body.name}.${field}`, req)
          send(res, 200, { ok: true, data: { removed: field === null ? body.name : `${body.name}.${field}` } })
          return
        }
        if (route === 'create') {
          if (!validateEntryName(body.name)) throw new Error('create: invalid name')
          const entry = String(body.name).trim()
          const fields: Record<string, string> = {
            url: asString(body.url, 2000) ?? '',
            username: asString(body.username, 2000) ?? '',
            note: asString(body.note, 2000) ?? '',
            env: asString(body.env, 200) ?? '',
            owner: asString(body.owner, 200) ?? '',
            password: genPassword(),
            totp: '',
            token: '',
          }
          for (const [k, v] of Object.entries(fields)) await setField(entry, k, v)
          log('create', entry, req)
          send(res, 200, { ok: true, data: { created: entry, passwordGenerated: true } })
          return
        }
        if (route === 'save') {
          const msg = asString(body.msg, 200) ?? 'vault panel changes'
          await git(['-C', vaultDir, 'add', '-A'], 20_000)
          const staged = await runOk(`${quote(gitBin)} -C ${quote(vaultDir)} diff --cached --quiet`)
          if (staged === 0) {
            send(res, 200, { ok: true, data: { committed: false, msg: 'nothing to commit' } })
            return
          }
          const out = await git(['-C', vaultDir, 'commit', '-q', '-m', msg], 20_000)
          log('save', msg, req)
          send(res, 200, { ok: true, data: { committed: true, msg: out.split('\n')[0] ?? msg } })
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
