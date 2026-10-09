/**
 * Same-origin fetch client for the `/vault-api` route registered by the node
 * half. Every call returns the unwrapped `data` payload or throws with the
 * server-provided error message.
 *
 * @module dsh-plugin-sops-vault/client/api
 */

const BASE = '/vault-api'

/** One field of one entry: encrypted fields carry no value. */
export interface FieldMeta {
  enc: boolean
  value?: string
}

/** Whole-vault metadata: entry name -> field name -> field meta. */
export type VaultMeta = Record<string, Record<string, FieldMeta>>

/** One live TOTP reading. */
export interface TotpResult {
  code: string
  remain: number
}

/**
 * `totp-batch` payload: many live codes from ONE host-side decryption, for the
 * 动态码 view. Requested entries without a usable seed are listed in `missing`.
 * Seeds never cross the API — only the derived 30-second codes do.
 */
export interface TotpBatch {
  /** Entry name → live code. */
  codes: Record<string, TotpResult>
  /** Requested names that produced no code (missing/invalid seed). */
  missing: string[]
  /** Host epoch ms when the codes were computed. */
  at: number
}

/** One browser-profile storage area of the Authenticator extension. */
export interface ImportSource {
  /** Browser family (`chrome`, `edge`, …). */
  browser: string
  /** Profile directory name (`Default`, `Profile 1`, …). */
  profile: string
  /** Extension id the storage belongs to. */
  extId: string
  /** Which extension storage area holds the entries. */
  area: 'sync' | 'local'
  /** Absolute directory the source was read from. */
  dir: string
  /** Entry count in this source. */
  entries: number
}

/**
 * One scanned TOTP entry, as offered for import. The base32 seed never crosses
 * the API — only its length does; the host re-reads the seed from disk by `id`
 * when the import is applied.
 */
export interface ImportEntry {
  /** Stable uuid of the source entry (the apply request keys on it). */
  id: string
  /** Index into `ImportScan.sources`. */
  source: number
  /** Issuer label, may be ''. */
  issuer: string
  /** Account label, may be ''. */
  account: string
  /** `totp` | `hotp` | `battle` | `steam` | `hex` | `hhex` | `unknown`. */
  type: string
  /** Code length in digits. */
  digits: number
  /** Refresh period in seconds. */
  period: number
  /** `sha1` | `sha256` | `sha512` | … */
  algorithm: string
  /** HOTP counter (0 for time-based entries). */
  counter: number
  /** Length of the base32 seed; the seed itself never crosses the API. */
  secretLen: number
  /** Whether the source stores this entry encrypted. */
  encrypted: boolean
  /** false => cannot be imported. */
  usable: boolean
  /** Why unusable, or why it will be skipped; '' when fine. */
  reason: string
  /** Suggested vault entry short name (issuer- or account-derived, no group prefix). */
  suggest: string
  /** Suggested url ('' when the issuer is not a hostname). */
  url: string
  /** A vault entry with this exact suggested name already exists. */
  exists: boolean
}

/** Whole `import-scan` payload. */
export interface ImportScan {
  sources: ImportSource[]
  entries: ImportEntry[]
  /** Names of the vault entries that already exist. */
  vaultEntries: string[]
}

/** One entry the user asked to import; the host resolves the seed from `id`. */
export interface ImportItem {
  id: string
  name: string
  username: string
  url: string
  note: string
  /** Replace an existing vault entry of the same name. */
  overwrite: boolean
}

/** Result of `import-apply`. */
export interface ImportResult {
  /** Vault names that were written. */
  imported: string[]
  /** Entries the host refused, with reasons. */
  skipped: Array<{ id: string; name: string; reason: string }>
  /** Entries whose write errored on the host; same shape as `skipped`. */
  failed?: Array<{ id: string; name: string; reason: string }>
  /** Item count the host received. */
  total?: number
}

/** Which level of the name hierarchy a logo belongs to. */
export type LogoScope = 'group' | 'sub' | 'entry'

/** The whole logo configuration (`<vaultDir>/logos.json`, plaintext metadata). */
export interface LogoMap {
  version: number
  /** Top-level group name -> logo value. */
  groups: Record<string, string>
  /** `group/sub` path -> logo value. */
  subGroups: Record<string, string>
  /** Full entry name -> logo value. */
  entries: Record<string, string>
}

/** `GET logos` payload: the map plus the raster files already uploaded. */
export interface LogosPayload {
  logos: LogoMap
  files: string[]
}

/** Result of a logo upload. */
export interface LogoUpload {
  /** The name actually stored (extension follows the sniffed format). */
  file: string
  bytes: number
  declared: string
}

/**
 * Call one API route.
 * @param route - sub-route under `/vault-api` (e.g. `meta`).
 * @param body - JSON body; presence selects POST, absence selects GET.
 * @returns the unwrapped data payload.
 */
export async function api<T>(route: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/${route}`, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let json: { ok?: boolean; data?: T; error?: string }
  try {
    json = await res.json() as { ok?: boolean; data?: T; error?: string }
  } catch {
    throw new Error(`vault api: HTTP ${String(res.status)} (non-JSON response)`)
  }
  if (!res.ok || json.ok !== true) throw new Error(json.error ?? `vault api: HTTP ${String(res.status)}`)
  return json.data as T
}
