/**
 * Host-half tests for the Chrome Authenticator importer
 * (`src/host/authenticator.ts`). The filesystem cases build a SYNTHETIC
 * Chromium profile tree with the LevelDB fixtures — no real browser profile is
 * ever read, and no real seed appears anywhere in this file.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  KNOWN_EXT_IDS,
  browserRoots,
  collectSeeds,
  discoverSources,
  judgeEntry,
  normalizeEntry,
  scanAuthenticator,
  seedLooksUsable,
  suggestName,
  suggestUrl,
  type ParsedEntry,
} from '../src/host/authenticator.ts'
import { encodeLog } from './fixtures/leveldb.ts'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-auth-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const EXT = KNOWN_EXT_IDS[1]!

/** One stored entry, in the shape the extension writes it. */
function stored(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    account: 'someone@example.com',
    dataType: 'OTPStorage',
    encrypted: false,
    hash: 'h-1',
    index: 0,
    issuer: 'example.com',
    secret: 'JBSWY3DPEHPK3PXP',
    type: 1,
    ...over,
  })
}

/** Build a fake Chromium profile with the given per-area storage keys. */
function fakeProfile(areas: { sync?: Record<string, string>; local?: Record<string, string> }): { root: string } {
  const root = tempDir()
  for (const [area, dirName] of [['sync', 'Sync Extension Settings'], ['local', 'Local Extension Settings']] as const) {
    const items = areas[area]
    if (items === undefined) continue
    const dir = join(root, 'Default', dirName, EXT)
    mkdirSync(dir, { recursive: true })
    const batch = Object.entries(items).map(([key, value], i) => ({ seq: i + 1, key, value }))
    writeFileSync(join(dir, '000003.log'), encodeLog([batch]))
  }
  return { root }
}

describe('browserRoots', () => {
  it('probes the platform-specific user-data directories', () => {
    const mac = browserRoots('darwin', '/Users/x', {})
    expect(mac[0]).toEqual({ label: 'chrome', root: '/Users/x/Library/Application Support/Google/Chrome' })
    expect(mac.map((b) => b.label)).toContain('edge')

    const win = browserRoots('win32', 'C:\\Users\\x', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })
    expect(win[0]!.root).toBe(join('C:\\Users\\x\\AppData\\Local', 'Google', 'Chrome', 'User Data'))

    const linux = browserRoots('linux', '/home/x', {})
    expect(linux[0]!.root).toBe('/home/x/.config/google-chrome')
  })
})

describe('normalizeEntry', () => {
  it('reads a plain numeric-type entry with defaults filled in', () => {
    const e = normalizeEntry(stored(), 'h-1')
    expect(e).toMatchObject({ id: 'h-1', issuer: 'example.com', type: 'totp', digits: 6, period: 30, algorithm: 'sha1', encrypted: false, index: 0 })
    expect(e?.secret).toBe('JBSWY3DPEHPK3PXP')
  })

  it('accepts the legacy string type and custom parameters', () => {
    const e = normalizeEntry(stored({ type: 'totp', digits: 8, period: 60, algorithm: 2 }), 'k')
    expect(e).toMatchObject({ type: 'totp', digits: 8, period: 60, algorithm: 'sha256' })
  })

  it('maps the numeric enum for the other flavours', () => {
    expect(normalizeEntry(stored({ type: 2 }), 'k')?.type).toBe('hotp')
    expect(normalizeEntry(stored({ type: 4 }), 'k')?.type).toBe('steam')
    expect(normalizeEntry(stored({ type: 99 }), 'k')?.type).toBe('unknown')
  })

  it('flags v2 (encrypted flag) and v3 (encData) entries and withholds the secret', () => {
    const v2 = normalizeEntry(stored({ encrypted: true, secret: 'U2FsdGVkX1+abc==' }), 'k')
    expect(v2).toMatchObject({ encrypted: true, secret: null })
    const v3 = normalizeEntry(JSON.stringify({ dataType: 'EncOTPStorage', keyId: 'kid', encData: 'U2FsdGVkX1+xyz==', hash: 'h-9', index: 3 }), 'h-9')
    expect(v3).toMatchObject({ id: 'h-9', encrypted: true, secret: null, type: 'unknown' })
  })

  it('ignores settings, key material and malformed values', () => {
    expect(normalizeEntry('{"storageLocation":"sync"}', 'UserSettings')).toBeNull()
    expect(normalizeEntry(JSON.stringify({ dataType: 'Key', key: 'x' }), 'kid')).toBeNull()
    expect(normalizeEntry('not json', 'k')).toBeNull()
    expect(normalizeEntry('[1,2,3]', 'k')).toBeNull()
    expect(normalizeEntry(stored({ secret: '' }), 'k')?.secret).toBeNull()
  })
})

describe('suggestName / suggestUrl', () => {
  it('strips an @domain tail and a parenthesised tail', () => {
    expect(suggestName('AWS-skyzhao1223@outlook.com', 'Authapp@707972170735')).toBe('AWS-skyzhao1223')
    expect(suggestName('', '官网后台(zhaotian1@wps.cn)')).toBe('官网后台')
    expect(suggestName('KSO-Jumpserver', 'zhaotian1')).toBe('KSO-Jumpserver')
  })

  it('falls back to the account, then to empty', () => {
    expect(suggestName('', 'skyzhao1223')).toBe('skyzhao1223')
    expect(suggestName('', '')).toBe('')
    expect(suggestName('  spaced   name  ', '')).toBe('spaced name')
  })

  it('only proposes a url when the issuer is a hostname', () => {
    expect(suggestUrl('sre.wps.cn')).toBe('https://sre.wps.cn')
    expect(suggestUrl('ksogitlab.wps.kingsoft.net')).toBe('https://ksogitlab.wps.kingsoft.net')
    expect(suggestUrl('PyPI')).toBe('')
    expect(suggestUrl('AWS-skyzhao1223@outlook.com')).toBe('')
    expect(suggestUrl('KSO-Jumpserver')).toBe('')
    expect(suggestUrl('')).toBe('')
  })
})

describe('seedLooksUsable / judgeEntry', () => {
  const totp = normalizeEntry(stored(), 'k') as ParsedEntry

  it('accepts base32 and rejects junk', () => {
    expect(seedLooksUsable('JBSWY3DPEHPK3PXP', 'totp')).toBe(true)
    expect(seedLooksUsable('jbswy3dpehpk3pxp', 'totp')).toBe(true)
    expect(seedLooksUsable('ABC', 'totp')).toBe(false)
    expect(seedLooksUsable('not base32!', 'totp')).toBe(false)
    expect(seedLooksUsable(null, 'totp')).toBe(false)
    expect(seedLooksUsable('stm-A1B2C3D4E5', 'steam')).toBe(true)
  })

  it('accepts a default-parameter TOTP entry with no warning', () => {
    expect(judgeEntry(totp)).toEqual({ usable: true, reason: '' })
  })

  it('warns but still accepts non-default parameters', () => {
    const wide = normalizeEntry(stored({ digits: 8 }), 'k') as ParsedEntry
    const judged = judgeEntry(wide, 'en')
    expect(judged.usable).toBe(true)
    expect(judged.reason).toMatch(/SHA-1 \/ 6 digits \/ 30 s/)
  })

  it('rejects counter-based, exotic and encrypted entries', () => {
    expect(judgeEntry(normalizeEntry(stored({ type: 2 }), 'k')!, 'en').usable).toBe(false)
    expect(judgeEntry(normalizeEntry(stored({ type: 4 }), 'k')!, 'en').usable).toBe(false)
    expect(judgeEntry(normalizeEntry(stored({ encrypted: true }), 'k')!, 'zh').usable).toBe(false)
    expect(judgeEntry(normalizeEntry(stored({ encrypted: true }), 'k')!, 'zh').reason).toContain('argon2')
  })
})

describe('discoverSources / scanAuthenticator / collectSeeds', () => {
  it('finds a known extension id and prefers the active storage area', () => {
    const { root } = fakeProfile({
      local: { UserSettings: JSON.stringify({ storageLocation: 'local' }), a: stored({ hash: 'a', issuer: 'local.example', index: 0 }) },
      sync: { b: stored({ hash: 'b', issuer: 'sync.example', index: 1 }), a: stored({ hash: 'a', issuer: 'stale-duplicate', index: 0 }) },
    })
    const roots = [{ label: 'test', root }]
    const found = discoverSources(roots)
    // discovery order is sync-then-local; the scan reorders by active area
    expect(found.map((s) => s.area)).toEqual(['sync', 'local'])

    const scan = scanAuthenticator({ roots, lang: 'en' })
    expect(scan.sources.map((s) => [s.area, s.entries])).toEqual([['local', 1], ['sync', 1]])
    // deduplicated by extension hash, and the active area's copy wins
    expect(scan.entries.map((e) => [e.issuer, e.source, e.suggest, e.usable])).toEqual([
      ['local.example', 0, 'local.example', true],
      ['sync.example', 1, 'sync.example', true],
    ])
  })

  it('marks an encrypted entry unusable with an actionable reason', () => {
    const { root } = fakeProfile({
      local: { UserSettings: JSON.stringify({ storageLocation: 'local' }), x: stored({ hash: 'x', encrypted: true, secret: 'U2FsdGVkX1+abc==' }) },
    })
    const scan = scanAuthenticator({ roots: [{ label: 'test', root }], lang: 'en' })
    expect(scan.entries).toHaveLength(1)
    expect(scan.entries[0]).toMatchObject({ usable: false, encrypted: true, secretLen: 0 })
    expect(scan.entries[0]!.reason).toMatch(/argon2/)
  })

  it('reports existing vault names and never hands a seed to the caller', () => {
    const { root } = fakeProfile({ sync: { a: stored({ hash: 'a', issuer: 'PyPI', account: 'me' }) } })
    const scan = scanAuthenticator({ roots: [{ label: 'test', root }], vaultEntries: ['PyPI'] })
    // the suggested name is kept as-is so the user can consciously overwrite it
    expect(scan.entries[0]).toMatchObject({ exists: true, suggest: 'PyPI' })
    expect(JSON.stringify(scan)).not.toContain('JBSWY3DPEHPK3PXP')
    expect(scan.entries[0]!.secretLen).toBe(16)
  })

  it('collectSeeds indexes by id for the write pass', () => {
    const { root } = fakeProfile({ sync: { a: stored({ hash: 'a' }), b: stored({ hash: 'b', type: 2 }) } })
    const seeds = collectSeeds([{ label: 'test', root }])
    expect([...seeds.keys()].sort()).toEqual(['a', 'b'])
    expect(seeds.get('a')?.secret).toBe('JBSWY3DPEHPK3PXP')
  })

  it('returns nothing for a profile without the extension', () => {
    const root = tempDir()
    mkdirSync(join(root, 'Default', 'Local Extension Settings', 'aaaabbbbccccddddeeeeffffgggghhhh'), { recursive: true })
    expect(discoverSources([{ label: 'test', root }])).toEqual([])
    expect(scanAuthenticator({ roots: [{ label: 'test', root }] }).entries).toEqual([])
  })
})
