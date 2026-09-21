/**
 * Pure UI logic shared by the panel and covered by `tests/client-logic.spec.ts`.
 * No React, no DOM, no fetch — deterministic transforms over vault metadata.
 *
 * @module dsh-plugin-sops-vault/client/logic
 */
import type { FieldMeta, VaultMeta } from './api.ts'

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
