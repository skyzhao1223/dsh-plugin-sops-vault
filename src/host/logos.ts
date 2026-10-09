/**
 * Logo configuration for groups, company sub-groups and entries.
 *
 * Deliberately stored OUTSIDE the encrypted document, in `<vaultDir>/logos.json`
 * next to `systems.md`: a logo is presentation metadata, not a credential, and
 * keeping it out of `secrets.yaml` means no `.sops.yaml` allowlist change and no
 * vault-wide re-encryption. Image bytes live in `<vaultDir>/logos/` and are
 * served by the `/vault-api/logo/<name>` route.
 *
 * One value, four forms (see {@link logoKind}):
 * - `text` — an emoji or up to 2 characters, rendered as the avatar itself
 * - `file` — a name inside `<vaultDir>/logos/`, served same-origin (offline-safe)
 * - `url`  — a remote image; the browser fetches it, so the remote host learns
 *   your IP and when you opened the panel (documented trade-off, opt-in per entry)
 * - `data` — an inline `data:image/...;base64,` URI
 *
 * Everything in this module is pure except the two filesystem helpers, and is
 * unit-tested in `tests/host-logos.spec.ts`.
 *
 * @module dsh-plugin-sops-vault/host/logos
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

/** Which level of the entry-name hierarchy a logo belongs to. */
export type LogoScope = 'group' | 'sub' | 'entry'

/** The whole logo configuration. */
export interface LogoMap {
  version: number
  /** Top-level group name -> logo (`工作`, `个人`, …). */
  groups: Record<string, string>
  /** `group/sub` path -> logo (`工作/金山办公`). */
  subGroups: Record<string, string>
  /** Full entry name -> logo. */
  entries: Record<string, string>
}

/** An empty, valid configuration. */
export function emptyLogos(): LogoMap {
  return { version: 1, groups: {}, subGroups: {}, entries: {} }
}

/** Largest accepted inline `data:` URI (it lives in a JSON file, keep it small). */
export const MAX_DATA_URI = 64 * 1024

/** Largest accepted uploaded image. */
export const MAX_UPLOAD_BYTES = 512 * 1024

/** Raster formats only: an SVG served from this origin could run script as a document. */
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'])

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
}

/* ------------------------------------------------------------------ */
/* value classification                                                */
/* ------------------------------------------------------------------ */

/** The rendering form of one logo value. */
export type LogoKind = 'none' | 'text' | 'file' | 'url' | 'data'

/**
 * Classify a logo value so the client knows how to render it. Pure.
 * @example
 * logoKind('💼')                    // 'text'
 * logoKind('wps.png')               // 'file'
 * logoKind('https://x/y.png')       // 'url'
 * logoKind('data:image/png;base64,')// 'data'
 */
export function logoKind(value: string | undefined | null): LogoKind {
  const v = (value ?? '').trim()
  if (v === '') return 'none'
  if (v.startsWith('data:image/')) return 'data'
  if (/^https?:\/\//i.test(v)) return 'url'
  if (/[\\/]/.test(v) || v.startsWith('.')) return 'none' // no paths, no dotfiles
  if (ALLOWED_EXT.has(extname(v).toLowerCase())) return 'file'
  // an emoji or a short label; array-spread counts code points, not UTF-16 units
  return [...v].length <= 2 ? 'text' : 'none'
}

/**
 * Validate one logo value for storage.
 * @returns the trimmed value ('' means remove), or null when unacceptable.
 */
export function validateLogoValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (v === '') return ''
  if (v.length > MAX_DATA_URI) return null
  if (/[\u0000-\u001f\u007f]/.test(v)) return null
  return logoKind(v) === 'none' ? null : v
}

/**
 * Validate an uploaded file name: no traversal, no dotfiles, raster extension.
 * @returns the safe bare name, or null.
 */
export function safeLogoName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const n = name.trim()
  if (n === '' || n.length > 100) return null
  if (/[\\/]/.test(n) || n.startsWith('.') || n === '..') return null
  if (!ALLOWED_EXT.has(extname(n).toLowerCase())) return null
  if (!/^[\w.@+-]+$/i.test(n)) return null
  return n
}

/**
 * Resolve a logo file inside `dir`, refusing anything that escapes it.
 * @returns the absolute path, or null when the name is unsafe.
 */
export function resolveLogoFile(dir: string, name: string): string | null {
  const safe = safeLogoName(name)
  if (safe === null) return null
  const root = resolve(dir)
  const full = resolve(root, safe)
  if (full !== root + sep + safe) return null
  return full
}

/** Content type for a logo file name. */
export function logoContentType(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Sniff raster magic bytes so an uploaded "image" cannot be HTML/script in
 * disguise. @returns the canonical extension, or null when unrecognized.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes
  // each branch requires exactly the bytes it reads, no more
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return '.png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg'
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return '.webp'
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) return '.ico'
  return null
}

/* ------------------------------------------------------------------ */
/* map operations (pure)                                               */
/* ------------------------------------------------------------------ */

const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** Validate a map key (a group name, `group/sub` path, or full entry name). */
export function validLogoKey(scope: LogoScope, key: unknown): key is string {
  if (typeof key !== 'string') return false
  const k = key.trim()
  if (k === '' || k.length > 200 || CONTROL_RE.test(k)) return false
  if (k !== key) return false
  const segments = k.split('/').filter(Boolean)
  if (scope === 'group') return segments.length === 1
  if (scope === 'sub') return segments.length === 2
  return segments.length >= 1
}

/** Parse `logos.json`, tolerating a missing/partial/corrupt file. */
export function parseLogos(text: string | null): LogoMap {
  const base = emptyLogos()
  if (text === null || text.trim() === '') return base
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return base
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base
  const obj = raw as Record<string, unknown>
  const pick = (field: string, scope: LogoScope): Record<string, string> => {
    const src = obj[field]
    const out: Record<string, string> = {}
    if (typeof src !== 'object' || src === null || Array.isArray(src)) return out
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (!validLogoKey(scope, k)) continue
      const value = validateLogoValue(v)
      if (value === null || value === '') continue
      out[k] = value
    }
    return out
  }
  return {
    version: typeof obj.version === 'number' ? obj.version : 1,
    groups: pick('groups', 'group'),
    subGroups: pick('subGroups', 'sub'),
    entries: pick('entries', 'entry'),
  }
}

/** Serialize deterministically (sorted keys) so git diffs stay readable. */
export function serializeLogos(map: LogoMap): string {
  const sorted = (rec: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const k of Object.keys(rec).sort()) out[k] = rec[k]!
    return out
  }
  return `${JSON.stringify({
    version: map.version,
    groups: sorted(map.groups),
    subGroups: sorted(map.subGroups),
    entries: sorted(map.entries),
  }, null, 2)}\n`
}

/** The bucket one scope writes into. */
function bucket(map: LogoMap, scope: LogoScope): Record<string, string> {
  return scope === 'group' ? map.groups : scope === 'sub' ? map.subGroups : map.entries
}

/**
 * Return a new map with one logo set (or removed when `value` is ''). Pure.
 * @returns the new map, or null when the key/value is invalid.
 */
export function withLogo(map: LogoMap, scope: LogoScope, key: string, value: string): LogoMap | null {
  if (!validLogoKey(scope, key)) return null
  const v = validateLogoValue(value)
  if (v === null) return null
  const next: LogoMap = {
    version: map.version,
    groups: { ...map.groups },
    subGroups: { ...map.subGroups },
    entries: { ...map.entries },
  }
  const target = bucket(next, scope)
  if (v === '') delete target[key]
  else target[key] = v
  return next
}

/**
 * Cascade one rename through every bucket: an exact key match is renamed, and
 * any key UNDER the old name (renaming a whole company, e.g. `工作/中化能源` ->
 * `工作/中化`) is re-rooted. Pure.
 */
export function renameLogos(map: LogoMap, oldName: string, newName: string): LogoMap {
  const move = (rec: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(rec)) {
      if (k === oldName) out[newName] = v
      else if (k.startsWith(`${oldName}/`)) out[newName + k.slice(oldName.length)] = v
      else out[k] = v
    }
    return out
  }
  return { version: map.version, groups: move(map.groups), subGroups: move(map.subGroups), entries: move(map.entries) }
}

/** Look up the logo for one entry, falling back to its sub-group then group. */
export function logoFor(map: LogoMap, entry: string): string {
  const parts = entry.split('/')
  if (map.entries[entry]) return map.entries[entry]!
  if (parts.length >= 2) {
    const sub = `${parts[0]}/${parts[1]}`
    if (map.subGroups[sub]) return map.subGroups[sub]!
  }
  if (parts.length >= 1 && map.groups[parts[0]!]) return map.groups[parts[0]!]!
  return ''
}

/* ------------------------------------------------------------------ */
/* filesystem                                                          */
/* ------------------------------------------------------------------ */

/** Read `<vaultDir>/logos.json`; a missing or corrupt file yields an empty map. */
export function readLogosFile(vaultDir: string): LogoMap {
  try {
    return parseLogos(readFileSync(join(vaultDir, 'logos.json'), 'utf8'))
  } catch {
    return emptyLogos()
  }
}

/**
 * Atomically write `<vaultDir>/logos.json` (temp file + rename) so a crash
 * cannot leave a truncated config behind.
 */
export function writeLogosFile(vaultDir: string, map: LogoMap): void {
  const target = join(vaultDir, 'logos.json')
  const tmp = `${target}.tmp`
  writeFileSync(tmp, serializeLogos(map), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, target)
}

/** Ensure `<vaultDir>/logos/` exists and list the raster files in it. */
export function listLogoFiles(vaultDir: string): string[] {
  const dir = join(vaultDir, 'logos')
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 })
    } catch {
      return []
    }
  }
  try {
    return readdirSync(dir)
      .filter((n) => ALLOWED_EXT.has(extname(n).toLowerCase()))
      .sort()
  } catch {
    return []
  }
}
