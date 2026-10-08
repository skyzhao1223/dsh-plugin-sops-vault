/**
 * Chrome "Authenticator" (Authenticator-Extension) → vault import.
 *
 * The extension keeps its OTP entries in a Chromium extension-storage LevelDB,
 * NOT in a file the user can point at: `<profile>/Sync Extension Settings/<id>/`
 * when its `storageLocation` is `sync` (the default once Chrome sync is on), or
 * `<profile>/Local Extension Settings/<id>/` otherwise. Each entry is one
 * storage key whose value is a JSON object (`dataType: "OTPStorage"`).
 *
 * This module only ever READS those files. Seeds are held in host memory for
 * the duration of one request and are written straight into the sops-encrypted
 * vault; they are never returned to the browser, never logged and never written
 * to a temp file. `ScannedEntry` carries `secretLen` instead of the seed.
 *
 * Entries the extension encrypted with a passphrase (`encrypted: true`, or the
 * v3 `EncOTPStorage` shape) are reported as unusable: unlocking them needs the
 * extension's argon2 key derivation, which is out of scope for a plugin that
 * ships no native/crypto dependency. The scan says so explicitly instead of
 * silently dropping rows.
 *
 * @module dsh-plugin-sops-vault/host/authenticator
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { join } from 'node:path'
import { readLevelDb } from './leveldb.ts'

/** Chrome Web Store ids of the Authenticator extension (legacy + current). */
export const KNOWN_EXT_IDS: readonly string[] = [
  'bhghoamapffpbohfmigpbljbmjdncfkk',
  'bhghoamapcdpbohphigoooaddinpkbai',
]

/** Storage keys the extension uses that are not OTP entries. */
const NON_ENTRY_KEYS = new Set(['UserSettings', 'keys', 'encoded', 'encryption'])

/** Numeric `OTPType` enum of the extension, plus its legacy string spellings. */
const TYPE_NAMES: Record<number, string> = {
  1: 'totp', 2: 'hotp', 3: 'battle', 4: 'steam', 5: 'hex', 6: 'hhex',
}

/** Numeric `OTPAlgorithm` enum of the extension. */
const ALGO_NAMES: Record<number, string> = {
  1: 'sha1', 2: 'sha256', 3: 'sha512', 4: 'gost3411-2012-256', 5: 'gost3411-2012-512',
}

/** Storage-area directories worth probing, in the order the extension prefers. */
const AREAS = ['sync', 'local'] as const

/** Which extension-storage directory one `area` label maps to. */
const AREA_DIR: Record<(typeof AREAS)[number], string> = {
  sync: 'Sync Extension Settings',
  local: 'Local Extension Settings',
}

/* ------------------------------------------------------------------ */
/* browser / profile discovery                                         */
/* ------------------------------------------------------------------ */

/** One Chromium user-data root, with a short display label. */
export interface BrowserRoot {
  label: string
  root: string
}

/**
 * Candidate Chromium user-data directories for this platform. Pure (no fs
 * access) so it is unit-testable; callers filter by `existsSync`.
 * @param platform - `process.platform` value.
 * @param home - user home directory.
 * @param env - environment (Windows needs `LOCALAPPDATA`).
 */
export function browserRoots(platform: string = osPlatform(), home: string = homedir(), env: NodeJS.ProcessEnv = process.env): BrowserRoot[] {
  if (platform === 'darwin') {
    const app = join(home, 'Library', 'Application Support')
    return [
      { label: 'chrome', root: join(app, 'Google', 'Chrome') },
      { label: 'chrome-beta', root: join(app, 'Google', 'Chrome Beta') },
      { label: 'chrome-canary', root: join(app, 'Google', 'Chrome Canary') },
      { label: 'chromium', root: join(app, 'Chromium') },
      { label: 'edge', root: join(app, 'Microsoft Edge') },
      { label: 'brave', root: join(app, 'BraveSoftware', 'Brave-Browser') },
      { label: 'vivaldi', root: join(app, 'Vivaldi') },
      { label: 'arc', root: join(app, 'Arc', 'User Data') },
      { label: 'opera', root: join(app, 'com.operasoftware.Opera') },
    ]
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      { label: 'chrome', root: join(local, 'Google', 'Chrome', 'User Data') },
      { label: 'chromium', root: join(local, 'Chromium', 'User Data') },
      { label: 'edge', root: join(local, 'Microsoft', 'Edge', 'User Data') },
      { label: 'brave', root: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { label: 'vivaldi', root: join(local, 'Vivaldi', 'User Data') },
    ]
  }
  const cfg = join(home, '.config')
  return [
    { label: 'chrome', root: join(cfg, 'google-chrome') },
    { label: 'chromium', root: join(cfg, 'chromium') },
    { label: 'edge', root: join(cfg, 'microsoft-edge') },
    { label: 'brave', root: join(cfg, 'BraveSoftware', 'Brave-Browser') },
    { label: 'vivaldi', root: join(cfg, 'vivaldi') },
  ]
}

/** One located extension-storage directory holding Authenticator data. */
export interface DiscoveredSource {
  browser: string
  profile: string
  extId: string
  area: (typeof AREAS)[number]
  dir: string
}

/** List profile directories of one browser root (`Default`, `Profile 1`, …). */
function profilesOf(root: string): string[] {
  let names: string[]
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  return names.filter((n) => n === 'Default' || /^Profile \d+$/.test(n) || n === 'Guest Profile')
}

/**
 * Read an extension's display name, resolving `__MSG_*__` through its
 * `_locales/<default_locale>/messages.json`. Best-effort: '' when unknown.
 */
function extName(extDir: string): string {
  try {
    const versions = readdirSync(extDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    const manifestPath = join(extDir, versions[versions.length - 1] ?? '', 'manifest.json')
    if (!existsSync(manifestPath)) return ''
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; default_locale?: string }
    const raw = manifest.name ?? ''
    const m = /^__MSG_(\w+)__$/.exec(raw)
    if (!m) return raw
    const locale = manifest.default_locale ?? 'en'
    const msgPath = join(extDir, versions[versions.length - 1] ?? '', '_locales', locale, 'messages.json')
    if (!existsSync(msgPath)) return ''
    const messages = JSON.parse(readFileSync(msgPath, 'utf8')) as Record<string, { message?: string }>
    const key = Object.keys(messages).find((k) => k.toLowerCase() === m[1]!.toLowerCase())
    return key === undefined ? '' : (messages[key]?.message ?? '')
  } catch {
    return ''
  }
}

/**
 * Find every extension-storage directory that plausibly holds Authenticator
 * data: the two known store ids first, then (only if those miss) any installed
 * extension whose manifest name contains "authenticator".
 * @param roots - browser user-data roots to probe (missing ones are skipped).
 */
export function discoverSources(roots: readonly BrowserRoot[] = browserRoots()): DiscoveredSource[] {
  const out: DiscoveredSource[] = []
  for (const { label, root } of roots) {
    if (!existsSync(root)) continue
    for (const profile of profilesOf(root)) {
      const profileDir = join(root, profile)
      const found = new Set<string>()
      for (const area of AREAS) {
        const areaRoot = join(profileDir, AREA_DIR[area])
        for (const extId of KNOWN_EXT_IDS) {
          const dir = join(areaRoot, extId)
          if (!existsSync(dir)) continue
          found.add(extId)
          out.push({ browser: label, profile, extId, area, dir })
        }
      }
      if (found.size > 0) continue
      // fallback: identify the extension by name (forks, dev builds, other stores)
      try {
        const installed = readdirSync(join(profileDir, 'Extensions'), { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^[a-p]{32}$/.test(d.name)).map((d) => d.name).slice(0, 200)
        for (const extId of installed) {
          if (!/authenticator/i.test(extName(join(profileDir, 'Extensions', extId)))) continue
          for (const area of AREAS) {
            const dir = join(profileDir, AREA_DIR[area], extId)
            if (existsSync(dir)) out.push({ browser: label, profile, extId, area, dir })
          }
        }
      } catch {
        /* no Extensions dir: nothing to fall back to */
      }
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* entry parsing                                                       */
/* ------------------------------------------------------------------ */

/** One OTP entry as the extension stores it (all fields optional/legacy-tolerant). */
export interface ParsedEntry {
  /** Extension-side stable id (`hash`), or a synthesized fallback. */
  id: string
  issuer: string
  account: string
  type: string
  digits: number
  period: number
  algorithm: string
  counter: number
  /** base32 seed, or null when the entry is passphrase-encrypted. */
  secret: string | null
  /** True when the extension stored this entry encrypted. */
  encrypted: boolean
  /** Raw storage key, for id synthesis. */
  storageKey: string
  /** The extension's own display order (`index`); absent → sorted last. */
  index: number
}

const B32_RE = /^[A-Z2-7]+=*$/i
const HEX_RE = /^[0-9a-f]+$/i

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Normalize one raw storage value into a {@link ParsedEntry}.
 * @returns null when the value is not an OTP entry (settings, key material,
 *   malformed JSON, or a shape this importer does not understand).
 */
export function normalizeEntry(raw: string, storageKey: string): ParsedEntry | null {
  if (NON_ENTRY_KEYS.has(storageKey)) return null
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    obj = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const dataType = str(obj.dataType)
  if (dataType === 'Key') return null
  const isEncV3 = dataType === 'EncOTPStorage' || (typeof obj.encData === 'string' && obj.encData !== '')
  const encrypted = isEncV3 || obj.encrypted === true
  const secretRaw = str(obj.secret)
  if (encrypted || secretRaw === '') {
    return {
      id: str(obj.hash) || `${storageKey}`,
      issuer: str(obj.issuer),
      account: str(obj.account),
      type: 'unknown',
      digits: 6,
      period: 30,
      algorithm: 'sha1',
      counter: 0,
      secret: null,
      encrypted: true,
      storageKey,
      index: typeof obj.index === 'number' ? obj.index : Number.MAX_SAFE_INTEGER,
    }
  }
  const typeRaw = obj.type
  const type = typeof typeRaw === 'number'
    ? (TYPE_NAMES[typeRaw] ?? 'unknown')
    : (typeof typeRaw === 'string' && typeRaw !== '' ? typeRaw.toLowerCase().replace(/^ht/, '') : 'totp')
  const algoRaw = obj.algorithm
  const algorithm = typeof algoRaw === 'number' ? (ALGO_NAMES[algoRaw] ?? 'sha1') : (str(algoRaw).toLowerCase() || 'sha1')
  return {
    id: str(obj.hash) || storageKey,
    issuer: str(obj.issuer),
    account: str(obj.account),
    type,
    digits: num(obj.digits, 6),
    period: num(obj.period, 30),
    algorithm,
    counter: typeof obj.counter === 'number' ? obj.counter : 0,
    secret: secretRaw.trim(),
    encrypted: false,
    storageKey,
    index: typeof obj.index === 'number' ? obj.index : Number.MAX_SAFE_INTEGER,
  }
}

/* ------------------------------------------------------------------ */
/* naming suggestions                                                  */
/* ------------------------------------------------------------------ */

/** A hostname-looking issuer (dots, no spaces, no `@`, sane TLD). */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/**
 * Suggest a vault entry short name from the extension's issuer/account.
 * Strips a parenthesised tail, an `@domain` tail and surrounding noise, but
 * keeps the result recognizable. Pure.
 *
 * @example
 * suggestName('AWS-skyzhao1223@outlook.com', 'Authapp@707972170735') // 'AWS-skyzhao1223'
 * suggestName('', '官网后台(zhaotian1@wps.cn)')                       // '官网后台'
 */
export function suggestName(issuer: string, account: string): string {
  let base = (issuer || '').trim()
  if (base === '') base = (account || '').trim()
  base = base.replace(/\s*[(（][^)）]*[)）]\s*$/u, '')
  base = base.replace(/@[^@\s]+$/, '')
  base = base.replace(/\s+/gu, ' ').trim()
  if (base.length > 80) base = base.slice(0, 80).trim()
  return base
}

/**
 * Suggest a `url` field: only when the issuer itself is a hostname. Everything
 * else stays empty rather than guessing a domain. Pure.
 */
export function suggestUrl(issuer: string): string {
  const host = (issuer || '').trim()
  if (host === '' || host.includes('@') || !HOST_RE.test(host)) return ''
  const dot = host.lastIndexOf('.')
  if (dot < 0 || host.length - dot - 1 < 2) return ''
  return `https://${host.toLowerCase()}`
}

/**
 * Does this entry's seed look usable by the vault's TOTP generator
 * (base32 or hex, at least 40 bits)? Pure.
 */
export function seedLooksUsable(secret: string | null, type: string): boolean {
  if (secret === null) return false
  if (type === 'hex' || type === 'hhex') return HEX_RE.test(secret) && secret.length >= 10
  if (type === 'steam' || type === 'battle') return /^(stm-|blz-|bliz-)/i.test(secret)
  return B32_RE.test(secret) && secret.replace(/[^A-Za-z2-7]/g, '').length >= 8
}

/* ------------------------------------------------------------------ */
/* scan                                                                */
/* ------------------------------------------------------------------ */

/** One browser storage area that yielded (or could yield) entries. */
export interface ImportSource {
  browser: string
  profile: string
  extId: string
  area: (typeof AREAS)[number]
  dir: string
  entries: number
}

/** One scanned entry as the browser sees it — no seed, only its length. */
export interface ScannedEntry {
  id: string
  source: number
  issuer: string
  account: string
  type: string
  digits: number
  period: number
  algorithm: string
  counter: number
  secretLen: number
  encrypted: boolean
  usable: boolean
  reason: string
  suggest: string
  url: string
  exists: boolean
}

/** Scan result: sources plus their entries (deduplicated by extension hash). */
export interface ScanResult {
  sources: ImportSource[]
  entries: ScannedEntry[]
}

/** Options for {@link scanAuthenticator}. */
export interface ScanOptions {
  /** Extra/override browser roots; defaults to platform auto-discovery. */
  roots?: readonly BrowserRoot[]
  /** Existing vault entry names, used to set `exists`. */
  vaultEntries?: readonly string[]
  /** Locale for reason strings (default 'zh'). */
  lang?: 'zh' | 'en'
}

/** Reason strings, kept out of the client bundle (host-side, bilingual). */
function reasons(lang: 'zh' | 'en'): Record<string, string> {
  return lang === 'en'
    ? {
        encrypted: 'encrypted with the extension passphrase (argon2 + AES); remove the password in Authenticator and rescan, or use its own export',
        noSecret: 'no seed stored',
        badSeed: 'seed is not base32/hex — cannot be used by the vault',
        counter: 'counter-based (HOTP): the panel only computes time-based TOTP',
        exotic: 'non-standard OTP flavour: the panel only computes RFC 6238 codes',
        params: 'non-default parameters — the panel ring always computes SHA-1 / 6 digits / 30 s',
      }
    : {
        encrypted: '扩展口令加密（argon2 + AES）：请在 Authenticator 里关闭密码后重扫，或用扩展自带导出',
        noSecret: '没有存种子',
        badSeed: '种子不是 base32/hex，库里用不了',
        counter: '计数器型（HOTP）：面板只会算基于时间的 TOTP',
        exotic: '非标准 OTP 类型：面板只会算 RFC 6238 动态码',
        params: '参数非默认值 —— 面板的倒计时环固定按 SHA-1 / 6 位 / 30 秒计算',
      }
}

/**
 * Scan every located Authenticator store and return metadata for the panel.
 * The active storage area (per the extension's own `UserSettings`) is listed
 * first, and entries are deduplicated by their extension-side hash so a
 * local+sync pair never imports twice. Seeds stay inside this process.
 */
export function scanAuthenticator(options: ScanOptions = {}): ScanResult {
  const lang = options.lang ?? 'zh'
  const discovered = discoverSources(options.roots)

  // Prefer the area the extension itself says is active.
  const active = detectActiveArea(discovered)
  const ordered = [...discovered].sort((a, b) => {
    const rank = (s: DiscoveredSource): number => (s.area === active ? 0 : 1)
    return rank(a) - rank(b)
  })

  const sources: ImportSource[] = []
  const entries: ScannedEntry[] = []
  const seen = new Set<string>()
  /** Names already handed out by this scan, so two rows never collide. */
  const usedNames = new Set<string>()

  ordered.forEach((src, index) => {
    let db: Map<string, Uint8Array>
    try {
      db = readLevelDb(src.dir)
    } catch {
      db = new Map()
    }
    let count = 0
    const parsed: ParsedEntry[] = []
    for (const [key, value] of db) {
      const entry = normalizeEntry(Buffer.from(value).toString('utf8'), key)
      if (entry === null) continue
      parsed.push(entry)
    }
    parsed.sort((a, b) => a.index - b.index || a.storageKey.localeCompare(b.storageKey))
    sources.push({ browser: src.browser, profile: src.profile, extId: src.extId, area: src.area, dir: src.dir, entries: parsed.length })
    for (const entry of parsed) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      count += 1
      const suggested = suggestName(entry.issuer, entry.account)
      const base = suggested === '' ? `${lang === 'en' ? 'unnamed' : '未命名'}-${String(entries.length + 1)}` : suggested
      let suggest = base
      let n = 2
      while (usedNames.has(suggest)) {
        suggest = `${base}·${String(n)}`
        n += 1
      }
      usedNames.add(suggest)
      const { usable, reason } = judgeEntry(entry, lang)
      // A vault entry with this exact name already exists: the panel shows it
      // unchecked so the user opts into overwriting that entry's seed.
      const exists = (options.vaultEntries ?? []).includes(suggest)
      entries.push({
        id: entry.id,
        source: index,
        issuer: entry.issuer,
        account: entry.account,
        type: entry.type,
        digits: entry.digits,
        period: entry.period,
        algorithm: entry.algorithm,
        counter: entry.counter,
        secretLen: entry.secret?.length ?? 0,
        encrypted: entry.encrypted,
        usable,
        reason,
        suggest,
        url: suggestUrl(entry.issuer),
        exists,
      })
    }
    sources[index] = { ...sources[index]!, entries: count }
  })

  return { sources, entries }
}

/**
 * Decide importability + a human reason for one parsed entry. Pure.
 * @param lang - language of the `reason` string.
 */
export function judgeEntry(entry: ParsedEntry, lang: 'zh' | 'en' = 'zh'): { usable: boolean; reason: string } {
  const R = reasons(lang)
  if (entry.encrypted) return { usable: false, reason: R.encrypted ?? 'encrypted' }
  if (entry.secret === null || entry.secret === '') return { usable: false, reason: R.noSecret ?? 'no seed' }
  if (!seedLooksUsable(entry.secret, entry.type)) return { usable: false, reason: R.badSeed ?? 'bad seed' }
  if (entry.type === 'hotp') return { usable: false, reason: R.counter ?? 'HOTP unsupported' }
  if (entry.type !== 'totp') return { usable: false, reason: R.exotic ?? 'unsupported type' }
  if (entry.digits !== 6 || entry.period !== 30 || entry.algorithm !== 'sha1') {
    return { usable: true, reason: R.params ?? 'non-default parameters' }
  }
  return { usable: true, reason: '' }
}

/**
 * Read the extension's `UserSettings.storageLocation` to learn which area is
 * authoritative. Defaults to 'sync' (what the extension falls back to).
 */
export function detectActiveArea(sources: readonly DiscoveredSource[]): (typeof AREAS)[number] {
  for (const src of sources) {
    let db: Map<string, Uint8Array>
    try {
      db = readLevelDb(src.dir)
    } catch {
      continue
    }
    const settings = db.get('UserSettings')
    if (settings === undefined) continue
    try {
      const obj = JSON.parse(Buffer.from(settings).toString('utf8')) as { storageLocation?: unknown }
      if (obj.storageLocation === 'local') return 'local'
      if (obj.storageLocation === 'sync') return 'sync'
    } catch {
      /* unreadable settings: keep looking */
    }
  }
  return 'sync'
}

/* ------------------------------------------------------------------ */
/* apply-side lookup                                                   */
/* ------------------------------------------------------------------ */

/** Seeds keyed by entry id, for one write pass. Never leaves the host. */
export type SeedMap = Map<string, ParsedEntry>

/**
 * Re-scan and index every parsed entry by id so an apply request can look up a
 * seed by the id the browser echoes back. The browser never sees a seed, so it
 * cannot substitute one: unknown ids are simply not found.
 */
export function collectSeeds(roots?: readonly BrowserRoot[]): SeedMap {
  const out: SeedMap = new Map()
  for (const src of discoverSources(roots)) {
    let db: Map<string, Uint8Array>
    try {
      db = readLevelDb(src.dir)
    } catch {
      continue
    }
    for (const [key, value] of db) {
      const entry = normalizeEntry(Buffer.from(value).toString('utf8'), key)
      if (entry === null) continue
      if (!out.has(entry.id)) out.set(entry.id, entry)
    }
  }
  return out
}

/** Human label of one source, e.g. `chrome/Default` — used in the note field. */
export function sourceLabel(source: ImportSource): string {
  return `${source.browser}/${source.profile}`
}
