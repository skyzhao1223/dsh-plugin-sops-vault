/**
 * Vault domain logic, implemented inline against sops/git/age — no external
 * `vault` CLI dependency. Everything in this module is pure (text in, data
 * out) except the crypto helpers, and is unit-tested in `tests/host.spec.ts`.
 *
 * Storage conventions (matching a standard sops+age vault repository):
 * - `<vaultDir>/secrets.yaml`  — sops-encrypted YAML, entries under a top-level
 *   `systems:` map, 4-space entry keys / 8-space field keys (sops emitter style)
 * - `<vaultDir>/.sops.yaml`    — creation rules; this plugin assumes the
 *   allowlist mode (`unencrypted_regex`: everything encrypted except listed)
 *
 * @module dsh-plugin-sops-vault/host/vault
 */
import { createHmac, randomBytes } from 'node:crypto'

/** URL prefix of the JSON API registered on the DSH web server. */
export const API_PATH = '/vault-api'

/* ------------------------------------------------------------------ */
/* shell argument helpers                                              */
/* ------------------------------------------------------------------ */

/** POSIX single-quote a shell argument. */
export function quote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Build a sops `--extract` / `set` / `unset` path: one bracket group per
 * segment, each a JSON-quoted string. NOTE: sops paths are NOT JSON arrays —
 * `["a","b"]` would be treated as one malformed key.
 */
export function sopsPath(segments: readonly string[]): string {
  return segments.map((s) => `[${JSON.stringify(s)}]`).join('')
}

/* ------------------------------------------------------------------ */
/* request policy + validation                                         */
/* ------------------------------------------------------------------ */

/**
 * Origin policy: reject cross-origin and `null` browser requests (drive-by
 * CSRF); allow requests without an Origin header (non-browser local callers,
 * same trust domain as the vault files themselves).
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

const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** Validate a vault entry name (e.g. `工作/公司VPN`). */
export function validateEntryName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 200
    && !CONTROL_RE.test(name) && name === name.trim()
}

/** Validate a field name (YAML key under one entry). */
export function validateFieldName(field: unknown): field is string {
  return typeof field === 'string' && field.length > 0 && field.length <= 100
    && !CONTROL_RE.test(field) && !/[\s:#'"\\]/.test(field) && field === field.trim()
}

/** Clamp an unknown body value to a bounded string, rejecting control chars. */
export function asString(value: unknown, max = 4096): string | null {
  if (typeof value !== 'string') return null
  if (value.length > max) return null
  if (CONTROL_RE.test(value.replace(/[\n\t]/g, ' '))) return null
  return value
}

/** Extract the API sub-route from a request URL under {@link API_PATH}. */
export function subPath(url: string): string {
  const path = url.split('?')[0] ?? ''
  return path.startsWith(API_PATH) ? path.slice(API_PATH.length).replace(/^\//, '') : path
}

/* ------------------------------------------------------------------ */
/* vault structure parsing (no decryption needed)                      */
/* ------------------------------------------------------------------ */

/** One field of one entry: encrypted fields carry no value. */
export interface FieldMeta {
  enc: boolean
  value?: string
}

/** Whole-vault metadata: entry name -> field name -> field meta. */
export type VaultMeta = Record<string, Record<string, FieldMeta>>

/**
 * Parse a sops-encrypted vault YAML WITHOUT decrypting: entry/field names and
 * plaintext metadata values are read directly; `ENC[...]` values become
 * `{enc:true}` markers. Supports the flat emitter style sops writes for this
 * layout (block scalars are not expected for entry fields).
 */
export function parseRawVault(text: string): VaultMeta {
  const rows: VaultMeta = {}
  let entry: string | null = null
  for (const line of text.split('\n')) {
    if (/^sops:\s*$/.test(line)) break
    const em = /^ {4}([^\s#][^:]*):\s*$/.exec(line)
    if (em) {
      entry = em[1]!.trim()
      rows[entry] = {}
      continue
    }
    const fm = /^ {8}([^\s#-][^:]*):\s?(.*)$/.exec(line)
    if (fm && entry !== null) {
      const k = fm[1]!.trim()
      let v = (fm[2] ?? '').trim()
      if (v.startsWith('ENC[')) {
        rows[entry]![k] = { enc: true }
        continue
      }
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith(`'`) && v.endsWith(`'`)))) {
        v = v.slice(1, -1)
      }
      rows[entry]![k] = { enc: false, value: v }
    }
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* .sops.yaml allowlist handling                                       */
/* ------------------------------------------------------------------ */

/** Parsed `unencrypted_regex` allowlist. */
export interface AllowRule {
  rx: RegExp
  names: string[]
}

/**
 * Parse the allowlist regex out of a `.sops.yaml` document. Translates a
 * leading inline `(?i)` group (Go RE2 style) into a JS RegExp flag.
 * @returns the rule, or null when absent/unparseable.
 */
export function parseAllowRegex(sopsYaml: string): AllowRule | null {
  const m = /^\s*unencrypted_regex:\s*(.+?)\s*$/m.exec(sopsYaml)
  if (!m) return null
  let raw = m[1]!.trim()
  if (raw.length >= 2 && raw[0] === raw[raw.length - 1] && (raw[0] === `"` || raw[0] === `'`)) {
    raw = raw.slice(1, -1)
  }
  let flags = ''
  let body = raw
  const im = /^\(\?([a-z]+)\)/.exec(body)
  if (im) {
    if (im[1]!.includes('i')) flags += 'i'
    body = body.slice(im[0].length)
  }
  let rx: RegExp
  try {
    rx = new RegExp(body, flags)
  } catch {
    return null
  }
  let namesBody = body.replace(/^\^/, '').replace(/\$$/, '')
  if (namesBody.startsWith('(') && namesBody.endsWith(')')) namesBody = namesBody.slice(1, -1)
  const names = namesBody.split('|').filter(Boolean)
  return { rx, names }
}

/* ------------------------------------------------------------------ */
/* security audit                                                      */
/* ------------------------------------------------------------------ */

/** Field-name substrings that must never appear in the plaintext allowlist. */
export const SENSITIVE_WORDS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'totp', 'otp', 'pin',
  'key', 'credential', 'cert', 'private', 'sign', 'salt', 'seed', 'auth',
  'cookie', 'session', 'dsn', 'aes',
] as const

/** Allowlist names that contain a sensitive word but are genuinely public. */
export const ALLOWED_EXCEPTIONS = new Set(['sign_name', 'cert_path', 'key_name', 'auth_url'])

const SECRET_PREFIX = /^(sk-|pk-|rk-|AKIA|ASIA|LTAI|ghp_|gho_|glpat-|xox[baprs]-|eyJ|-----BEGIN|AIza|wx[0-9a-f]{16})/
const B64ISH = /^[A-Za-z0-9+/=_\-\.]+$/

/** Heuristic: does this plaintext value look like a credential? Prefers false positives over misses. */
export function looksLikeSecret(value: string): boolean {
  if (typeof value !== 'string' || value.length < 12) return false
  if (SECRET_PREFIX.test(value)) return true
  if (/\s/.test(value) || !B64ISH.test(value)) return false
  // Paths and URLs are not secrets (otherwise cert_path keeps tripping).
  if (value.startsWith('/') || value.startsWith('~') || value.startsWith('./') || value.includes('://')) return false
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value)
}

/** One audit finding. */
export interface AuditFinding {
  level: 'high' | 'warn'
  entry?: string
  field?: string
  detail: string
}

/** Audit result: structured findings + a printable report. */
export interface AuditResult {
  findings: AuditFinding[]
  report: string
}

/**
 * Audit the encrypted vault file against its allowlist rule — without
 * decrypting anything (plaintext-by-design fields are visible in the raw file;
 * encrypted ones are `ENC[...]`).
 *
 * Checks, in order of severity:
 * 1. high — a plaintext field NOT covered by the allowlist (rule not applied;
 *    the file needs re-encryption)
 * 2. high — an allowlist name containing a sensitive word (deliberate leak)
 * 3. warn — an allowlisted plaintext value that looks like a credential
 * 4. warn — an allowlisted field that is actually encrypted (stale allowlist
 *    spelling)
 */
export function auditVault(rawText: string, sopsYaml: string): AuditResult {
  const findings: AuditFinding[] = []
  const allow = parseAllowRegex(sopsYaml)
  const meta = parseRawVault(rawText)

  if (!allow) {
    findings.push({ level: 'high', detail: 'no unencrypted_regex allowlist found in .sops.yaml (blacklist mode is unsafe; switch to allowlist)' })
  }

  let enc = 0
  let plain = 0
  for (const [entry, fields] of Object.entries(meta)) {
    for (const [k, f] of Object.entries(fields)) {
      if (f.enc) {
        enc++
        if (allow && allow.rx.test(k)) {
          findings.push({ level: 'warn', entry, field: k, detail: 'allowlisted field is encrypted (allowlist spelling drift?)' })
        }
        continue
      }
      plain++
      if (!f.value) continue
      if (allow && !allow.rx.test(k)) {
        findings.push({ level: 'high', entry, field: k, detail: 'plaintext but NOT in allowlist — rule not applied to this file' })
      }
    }
  }
  if (allow) {
    for (const n of allow.names) {
      if (ALLOWED_EXCEPTIONS.has(n.toLowerCase())) continue
      if (SENSITIVE_WORDS.some((w) => n.toLowerCase().includes(w))) {
        findings.push({ level: 'high', field: n, detail: 'allowlist contains a sensitive field name (deliberate plaintext leak)' })
      }
    }
    for (const [entry, fields] of Object.entries(meta)) {
      for (const [k, f] of Object.entries(fields)) {
        if (!f.enc && f.value && allow.rx.test(k) && looksLikeSecret(f.value)) {
          findings.push({ level: 'warn', entry, field: k, detail: `allowlisted plaintext value looks like a credential (${f.value.length} chars)` })
        }
      }
    }
  }

  const highs = findings.filter((f) => f.level === 'high')
  const warns = findings.filter((f) => f.level === 'warn')
  const lines: string[] = [
    `fields: ${enc} encrypted / ${plain} plaintext (${Object.keys(meta).length} entries)`,
    `allowlist: ${allow ? `${allow.names.length} public field names` : 'MISSING'}`,
    '',
    highs.length === 0 ? '🔴 high: none' : '🔴 high:',
    ...highs.map((f) => `     ${f.entry ?? ''}${f.entry && f.field ? ' → ' : ''}${f.field ?? ''} — ${f.detail}`),
    '',
    warns.length === 0 ? '🟡 review: none' : '🟡 review:',
    ...warns.map((f) => `     ${f.entry ?? ''}${f.entry && f.field ? ' → ' : ''}${f.field ?? ''} — ${f.detail}`),
    '',
    'note: appid / serial_no style identifiers naturally trip the value heuristic; confirm and ignore, or tighten the allowlist.',
  ]
  return { findings, report: lines.join('\n') }
}

/* ------------------------------------------------------------------ */
/* crypto helpers                                                      */
/* ------------------------------------------------------------------ */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode a base32 (RFC 4648, unpadded) string. */
export function base32Decode(input: string): Uint8Array {
  const clean = input.trim().toUpperCase().replace(/[^A-Z2-7]/g, '')
  const out: number[] = []
  let bits = 0
  let buf = 0
  for (const c of clean) {
    const v = B32_ALPHABET.indexOf(c)
    if (v < 0) continue
    buf = (buf << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((buf >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/**
 * Compute the current TOTP (RFC 6238, SHA-1, 6 digits, 30s step).
 * @param seed - base32 secret.
 * @param now - epoch ms (injectable for tests).
 * @returns code + seconds until rotation, or null for an unusable seed.
 */
export function totpFromSeed(seed: string, now = Date.now()): { code: string; remain: number } | null {
  const key = base32Decode(seed)
  if (key.length < 5) return null
  const counter = Math.floor(now / 1000 / 30)
  const cb = Buffer.alloc(8)
  cb.writeUInt32BE(counter >>> 0, 4)
  const hmac = createHmac('sha1', Buffer.from(key)).update(cb).digest()
  const off = hmac[19]! & 0x0f
  const bin = ((hmac[off]! & 0x7f) << 24) | (hmac[off + 1]! << 16) | (hmac[off + 2]! << 8) | hmac[off + 3]!
  const code = ((bin % 1000000) + 1000000) % 1000000
  const remain = 30 - (Math.floor(now / 1000) % 30)
  return { code: String(code).padStart(6, '0'), remain }
}

const PW_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#%^_+=-'

/**
 * Generate an unbiased random password from a shell/YAML-safe alphabet.
 * @param len - length (default 24).
 */
export function genPassword(len = 24): string {
  const limit = 256 - (256 % PW_ALPHABET.length)
  let out = ''
  while (out.length < len) {
    const bytes = randomBytes(len * 2)
    for (const b of bytes) {
      if (b < limit) out += PW_ALPHABET[b % PW_ALPHABET.length]
      if (out.length >= len) break
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* access log                                                          */
/* ------------------------------------------------------------------ */

/** One access-log line: ISO time, action, target, source. NEVER a value. */
export function auditLine(action: string, target: string, source: string, at = new Date()): string {
  return `${at.toISOString()} ${action} ${target} src=${source}`
}
