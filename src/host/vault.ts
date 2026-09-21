/**
 * Pure helpers for the vault API route: command construction, output parsing,
 * origin policy, and input validation. Everything here is side-effect free and
 * unit-tested in `tests/host.spec.ts`.
 *
 * @module dsh-plugin-vault/host/vault
 */

/** URL prefix of the JSON API registered on the DSH web server. */
export const API_PATH = '/vault-api'

/**
 * POSIX single-quote a shell argument.
 * @param value - raw argument text.
 * @returns a single-quoted literal safe to concatenate into a command line.
 */
export function quote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Build the full `vault` CLI command line.
 * @param bin - absolute path to the vault script.
 * @param args - subcommand and arguments (each quoted).
 * @returns the shell command string.
 */
export function vaultCommand(bin: string, args: readonly string[]): string {
  return [quote(bin), ...args.map(quote)].join(' ')
}

/**
 * Parse `vault totp` output ("123456   剩余 27s" / "123456   27s").
 * @param out - raw command stdout.
 * @returns code + remaining seconds, or null when unparseable.
 */
export function parseTotpOutput(out: string): { code: string; remain: number } | null {
  const m = /(\d{4,8})\D+(\d+)/.exec(out)
  if (!m) return null
  return { code: m[1], remain: Number(m[2]) }
}

/**
 * Origin policy for the local API.
 *
 * Threat model: the DSH web server listens on loopback. Browser pages from
 * OTHER origins must never drive the vault (drive-by CSRF); non-browser local
 * callers (the user's own curl/scripts, same trust domain as the vault files
 * themselves) carry no Origin header and are allowed.
 *
 * @param originHeader - the request's `Origin` header, if any.
 * @param hostHeader - the request's `Host` header.
 * @returns true when the request may be served.
 */
export function isAllowedOrigin(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  if (originHeader === undefined || originHeader === '') return true
  if (originHeader === 'null') return false
  let originHost: string
  try {
    originHost = new URL(originHeader).host
  } catch {
    return false
  }
  return hostHeader !== undefined && hostHeader !== '' && originHost === hostHeader
}

/** Reject control characters and overlong strings in user-supplied identifiers. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/**
 * Validate a vault entry name (e.g. `工作/公司VPN`).
 * @param name - candidate entry name.
 * @returns true when acceptable.
 */
export function validateEntryName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 200
    && !CONTROL_RE.test(name) && name === name.trim()
}

/**
 * Validate a field name (YAML key under one entry).
 * @param field - candidate field name.
 * @returns true when acceptable.
 */
export function validateFieldName(field: unknown): field is string {
  return typeof field === 'string' && field.length > 0 && field.length <= 100
    && !CONTROL_RE.test(field) && !/[\s:#'"\\]/.test(field) && field === field.trim()
}

/**
 * Extract the API sub-route from a request URL under {@link API_PATH}.
 * @param url - raw `req.url` (may carry a query string).
 * @returns e.g. `"meta"` for `/vault-api/meta?x=1`; `""` for the bare prefix.
 */
export function subPath(url: string): string {
  const path = url.split('?')[0] ?? ''
  return path.startsWith(API_PATH) ? path.slice(API_PATH.length).replace(/^\//, '') : path
}

/** Clamp an unknown body value to a bounded string. */
export function asString(value: unknown, max = 4096): string | null {
  if (typeof value !== 'string') return null
  if (value.length > max) return null
  if (CONTROL_RE.test(value.replace(/[\n\t]/g, ' '))) return null
  return value
}
