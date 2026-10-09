/**
 * Pure UI logic shared by the panel and covered by `tests/client-logic.spec.ts`.
 * No React, no DOM, no fetch — deterministic transforms over vault metadata,
 * plus the naming/summary half of the Authenticator import flow.
 *
 * @module dsh-plugin-sops-vault/client/logic
 */
import type { FieldMeta, ImportEntry, VaultMeta } from './api.ts'

/** Deterministic avatar hue from an entry name. */
export function hueOf(s: string): number {
  let x = 0
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0
  return x % 360
}

/** Hostname of an http(s) URL, else ''. */
export function hostOf(u: string): string {
  const m = /^https?:\/\/([^/]+)/.exec(String(u ?? ''))
  return m ? m[1]! : ''
}

/** Whether a plaintext value should render as a clickable link. */
export function isLinkValue(v: string): boolean {
  return /^https?:\/\//.test(v)
}

/** Group prefix of an entry name (`工作/公司VPN` -> `工作`). */
export function groupName(entry: string): string {
  const i = entry.indexOf('/')
  return i > 0 ? entry.slice(0, i) : ''
}

/** Display name with the group prefix stripped. */
export function shortName(entry: string): string {
  const i = entry.indexOf('/')
  return i > 0 ? entry.slice(i + 1) : entry
}

/** Preferred group ordering; unknown groups sort alphabetically after. */
const GROUP_ORDER = ['工作', '服务', '生活']

/** Sort group names by the preferred order, then locale. */
export function orderGroups(names: readonly string[]): string[] {
  return [...names].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a)
    const ib = GROUP_ORDER.indexOf(b)
    return ((ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)) || a.localeCompare(b)
  })
}

/** Fields rendered as chips / footnotes instead of value rows. */
const CHROME_FIELDS = new Set(['env', 'owner', 'note', 'remark', 'totp'])

/** True when the entry matches the (lowercased, trimmed) query. */
export function matchEntry(fields: Record<string, FieldMeta>, name: string, q: string): boolean {
  if (!q) return true
  if (name.toLowerCase().includes(q)) return true
  for (const [k, f] of Object.entries(fields)) {
    if (k.toLowerCase().includes(q)) return true
    if (!f.enc && String(f.value ?? '').toLowerCase().includes(q)) return true
  }
  return false
}

/** Count of encrypted fields in one entry. */
export function encCount(fields: Record<string, FieldMeta>): number {
  return Object.values(fields).filter((f) => f && f.enc).length
}

/** Row subtitle: URL host, else appid, else username. */
export function entrySubline(fields: Record<string, FieldMeta>): string {
  const plain = (k: string): string => {
    const f = fields[k]
    return f && !f.enc ? String(f.value ?? '') : ''
  }
  return hostOf(plain('url')) || plain('appid') || plain('username') || ''
}

const LINK_FIELDS = new Set(['url', 'endpoint', 'restapi'])

/**
 * Visible field rows for one entry: chrome fields removed, empty plaintext
 * fields dropped, ordered link-first / plaintext / encrypted-last, then
 * alphabetical within a rank.
 */
export function fieldOrder(fields: Record<string, FieldMeta>): string[] {
  const keys = Object.keys(fields).filter((k) => {
    if (CHROME_FIELDS.has(k)) return false
    const f = fields[k]
    if (!f) return false
    if (f.enc) return true
    return String(f.value ?? '') !== ''
  })
  const rank = (k: string): number => (LINK_FIELDS.has(k) ? 0 : fields[k]!.enc ? 2 : 1)
  return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** Note/remark footnote text of one entry. */
export function noteOf(fields: Record<string, FieldMeta>): string {
  for (const k of ['note', 'remark']) {
    const f = fields[k]
    if (f && !f.enc && f.value) return f.value
  }
  return ''
}

/** Raw chip values (env + owner); the caller localizes labels. */
export function chipValues(fields: Record<string, FieldMeta>): { env: string; owner: string } {
  const env = fields.env
  const owner = fields.owner
  return {
    env: env && !env.enc && env.value ? env.value : '',
    owner: owner && !owner.enc && owner.value ? owner.value : '',
  }
}

/** Group visible entries into an ordered [group, names[]] list. */
export function groupEntries(meta: VaultMeta, visible: readonly string[], fallback = 'Ungrouped'): Array<[string, string[]]> {
  const groups: Record<string, string[]> = {}
  for (const n of visible) {
    const g = groupName(n) || fallback
    ;(groups[g] ??= []).push(n)
  }
  return orderGroups(Object.keys(groups)).map((g) => [g, groups[g]!] as [string, string[]])
}

/* ---------- data-kind filtering ("只看某类数据") ---------- */

/**
 * The kinds one entry can be filtered by. `totp` is the headline case: the
 * panel renders it as a live-codes list instead of the ordinary entry grid.
 */
export type DataKind = 'totp' | 'password' | 'secret'

/** Kinds in chip order. */
export const DATA_KINDS: readonly DataKind[] = ['totp', 'password', 'secret']

/** Encrypted field names that mean "an API key / token / credential". */
const SECRET_FIELD_RE = /(token|secret|key|credential|cookie|session|private|passwd|pwd|apiv3|sign|salt|seed|dsn|(^|[_-])(ak|sk)([_-]|$))/i

/**
 * Does one entry carry this kind of data?
 * - `totp`: an encrypted `totp` field (an empty one is plaintext, so no ring)
 * - `password`: an encrypted `password` field
 * - `secret`: any OTHER encrypted field with a credential-ish name
 */
export function hasKind(fields: Record<string, FieldMeta>, kind: DataKind): boolean {
  if (kind === 'totp') return fields.totp?.enc === true
  if (kind === 'password') return fields.password?.enc === true
  return Object.entries(fields).some(([k, f]) => f.enc && k !== 'totp' && k !== 'password' && SECRET_FIELD_RE.test(k))
}

/**
 * Which data kinds one entry carries, in row-badge display order
 * (password first — the most common question at a glance).
 */
export function entryKinds(fields: Record<string, FieldMeta>): DataKind[] {
  const order: DataKind[] = ['password', 'secret', 'totp']
  return order.filter((k) => hasKind(fields, k))
}

/** Entry count per kind, for the chip badges. */
export function countByKind(meta: VaultMeta): Record<DataKind, number> {
  const out = { totp: 0, password: 0, secret: 0 } as Record<DataKind, number>
  for (const fields of Object.values(meta)) {
    for (const kind of DATA_KINDS) if (hasKind(fields, kind)) out[kind] += 1
  }
  return out
}

/** Kinds worth offering as a chip (at least one entry has it). */
export function kindsPresent(meta: VaultMeta): DataKind[] {
  const counts = countByKind(meta)
  return DATA_KINDS.filter((k) => counts[k] > 0)
}

/** Names of the entries carrying one kind, in vault order. */
export function namesOfKind(meta: VaultMeta, kind: DataKind): string[] {
  return Object.keys(meta).filter((n) => hasKind(meta[n]!, kind))
}

/**
 * Live countdown for one code of a batch fetch: the host reported `remain`
 * seconds at fetch time, the view ticks `elapsedSec` locally.
 * @returns seconds left (clamped at 0), ring fraction, and whether the code has
 *   rotated and must be re-fetched.
 */
export function codeCountdown(remain: number, elapsedSec: number): { left: number; frac: number; expired: boolean } {
  const total = remain > 0 ? remain : 30
  const left = Math.max(0, Math.ceil(total - elapsedSec))
  return { left, frac: Math.max(0, Math.min(1, left / total)), expired: total - elapsedSec <= 0 }
}

/** Group a 6-digit code for display (`123456` → `123 456`); other lengths pass through. */
export function displayCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

/* ---------- Authenticator import ---------- */

/** Strip surrounding whitespace and slashes off one name part. */
function trimPart(s: string): string {
  return String(s ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '').trim()
}

/**
 * Target vault name of one import row: the group prefix and the suggested short
 * name joined with `/`, each trimmed of surrounding whitespace and slashes.
 * An empty prefix yields the bare short name; an empty short name yields `''`
 * (never a dangling group).
 */
export function importTargetName(prefix: string, suggest: string): string {
  const p = trimPart(prefix)
  const n = trimPart(suggest)
  if (n === '') return ''
  return p === '' ? n : `${p}/${n}`
}

/**
 * Note text stored on an imported entry, e.g.
 * `Authenticator 导入 2026-10-08 · chrome/Default · issuer=KSO-Jumpserver · account=zhaotian1`.
 * Empty parts are omitted. Never contains a secret: only the labels the scan
 * already exposes (issuer / account / source / date).
 */
export function importDefaultNote(issuer: string, account: string, sourceLabel: string, date: string): string {
  const d = trimPart(date)
  const src = trimPart(sourceLabel)
  const iss = trimPart(issuer)
  const acc = trimPart(account)
  const parts: string[] = []
  if (src !== '') parts.push(src)
  if (iss !== '') parts.push(`issuer=${iss}`)
  if (acc !== '') parts.push(`account=${acc}`)
  const head = d === '' ? 'Authenticator 导入' : `Authenticator 导入 ${d}`
  return [head, ...parts].join(' · ')
}

/**
 * One-line human summary of an applied import, for the toast.
 * @param imported - vault names that were written.
 * @param skipped - entries the host refused, with reasons.
 * @param t - translator; structural (string keys) so this module stays
 *   dictionary-agnostic. Keys used: `importSumOk`, `importSumSkip`, `importSumNone`.
 */
export function importSummaryText(
  imported: string[],
  skipped: { name: string; reason: string }[],
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  const done = imported.length
  const miss = skipped.length
  if (done === 0 && miss === 0) return t('importSumNone')
  const parts = [done > 0 ? t('importSumOk', { n: done }) : t('importSumNone')]
  if (miss > 0) parts.push(t('importSumSkip', { n: miss, first: skipped[0]!.name }))
  return parts.join(' · ')
}

/** Import candidates offered as checked by default: usable and not already in the vault. */
export function importSelectable(entries: ImportEntry[]): ImportEntry[] {
  return entries.filter((e) => e.usable && !e.exists)
}
