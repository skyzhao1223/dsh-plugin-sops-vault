/**
 * Host-half tests for the logo configuration store (`src/host/logos.ts`).
 * Pure map/value logic plus the on-disk helpers against a temp vault.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  emptyLogos, listLogoFiles, logoContentType, logoFor, logoKind, parseLogos,
  readLogosFile, renameLogos, resolveLogoFile, safeLogoName, serializeLogos,
  sniffImage, validLogoKey, validateLogoValue, withLogo, writeLogosFile,
} from '../src/host/logos.ts'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-logos-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** A minimal 1x1 PNG. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

describe('logoKind / validateLogoValue', () => {
  it('classifies the four accepted forms', () => {
    expect(logoKind('💼')).toBe('text')
    expect(logoKind('金')).toBe('text')
    expect(logoKind('AB')).toBe('text')
    expect(logoKind('wps.png')).toBe('file')
    expect(logoKind('a/b.JPG')).toBe('none')          // no paths
    expect(logoKind('https://x.example/y.png')).toBe('url')
    expect(logoKind('data:image/png;base64,AAA')).toBe('data')
    expect(logoKind('')).toBe('none')
    expect(logoKind(undefined)).toBe('none')
  })

  it('rejects traversal, dotfiles, svg and long words', () => {
    expect(logoKind('../evil.png')).toBe('none')
    expect(logoKind('.hidden.png')).toBe('none')
    expect(logoKind('logo.svg')).toBe('none')
    expect(logoKind('supercalifragilistic')).toBe('none')
    expect(validateLogoValue('../evil.png')).toBeNull()
    expect(validateLogoValue('logo.svg')).toBeNull()
    expect(validateLogoValue(123)).toBeNull()
    expect(validateLogoValue('  💼  ')).toBe('💼')
    expect(validateLogoValue('')).toBe('')             // '' means remove
  })

  it('caps data URIs and control characters', () => {
    expect(validateLogoValue(`data:image/png;base64,${'A'.repeat(70_000)}`)).toBeNull()
    expect(validateLogoValue('a\u0000b')).toBeNull()
  })
})

describe('safeLogoName / resolveLogoFile', () => {
  const dir = tempDir()

  it('accepts bare raster names only', () => {
    expect(safeLogoName('wps.png')).toBe('wps.png')
    expect(safeLogoName('a-b_c.1@x.webp')).toBe('a-b_c.1@x.webp')
    expect(safeLogoName('../x.png')).toBeNull()
    expect(safeLogoName('a/b.png')).toBeNull()
    expect(safeLogoName('.x.png')).toBeNull()
    expect(safeLogoName('x.svg')).toBeNull()
    expect(safeLogoName('x')).toBeNull()
    expect(safeLogoName(null)).toBeNull()
  })

  it('never resolves outside the logos directory', () => {
    expect(resolveLogoFile(dir, 'ok.png')).toBe(join(dir, 'ok.png'))
    expect(resolveLogoFile(dir, '../secrets.yaml')).toBeNull()
    expect(resolveLogoFile(dir, '..%2f..%2fx.png')).toBeNull()
    expect(resolveLogoFile(dir, '/etc/passwd.png')).toBeNull()
  })

  it('maps extensions to content types', () => {
    expect(logoContentType('a.png')).toBe('image/png')
    expect(logoContentType('a.JPG')).toBe('image/jpeg')
    expect(logoContentType('a.webp')).toBe('image/webp')
    expect(logoContentType('a.unknown')).toBe('application/octet-stream')
  })
})

describe('sniffImage', () => {
  it('recognizes raster magic bytes and refuses everything else', () => {
    expect(sniffImage(PNG)).toBe('.png')
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('.jpg')
    expect(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('.gif')
    expect(sniffImage(new TextEncoder().encode('<html><script>'))).toBeNull()
    expect(sniffImage(new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c]))).toBeNull() // "<?xml"
  })
})

describe('validLogoKey', () => {
  it('enforces the segment count per scope', () => {
    expect(validLogoKey('group', '工作')).toBe(true)
    expect(validLogoKey('group', '工作/金山办公')).toBe(false)
    expect(validLogoKey('sub', '工作/金山办公')).toBe(true)
    expect(validLogoKey('sub', '工作')).toBe(false)
    expect(validLogoKey('entry', '工作/金山办公/sre')).toBe(true)
    expect(validLogoKey('entry', '裸名')).toBe(true)
    expect(validLogoKey('entry', '')).toBe(false)
    expect(validLogoKey('entry', ' x')).toBe(false)
    expect(validLogoKey('entry', 42)).toBe(false)
  })
})

describe('parseLogos / serializeLogos', () => {
  it('tolerates missing, empty and corrupt files', () => {
    expect(parseLogos(null)).toEqual(emptyLogos())
    expect(parseLogos('')).toEqual(emptyLogos())
    expect(parseLogos('not json')).toEqual(emptyLogos())
    expect(parseLogos('[1,2]')).toEqual(emptyLogos())
    expect(parseLogos('{"groups": 5}')).toEqual(emptyLogos())
  })

  it('drops invalid keys and values while keeping the rest', () => {
    const map = parseLogos(JSON.stringify({
      version: 1,
      groups: { '工作': '💼', 'a/b': 'x', '': 'y' },
      subGroups: { '工作/金山办公': 'wps.png' },
      entries: { '个人/PyPI': '../evil.png', '个人/Mapbox': '🗺' },
    }))
    expect(map.groups).toEqual({ '工作': '💼' })
    expect(map.subGroups).toEqual({ '工作/金山办公': 'wps.png' })
    expect(map.entries).toEqual({ '个人/Mapbox': '🗺' })
  })

  it('serializes deterministically with sorted keys', () => {
    const a = withLogo(withLogo(emptyLogos(), 'entry', 'b', '🅱')!, 'entry', 'a', '🅰')!
    const b = withLogo(withLogo(emptyLogos(), 'entry', 'a', '🅰')!, 'entry', 'b', '🅱')!
    expect(serializeLogos(a)).toBe(serializeLogos(b))
    expect(serializeLogos(a).endsWith('\n')).toBe(true)
    expect(serializeLogos(a)).toContain('"a": "🅰"')
  })
})

describe('withLogo / logoFor / renameLogos', () => {
  it('sets and removes one logo', () => {
    const m1 = withLogo(emptyLogos(), 'group', '工作', '💼')!
    expect(m1.groups['工作']).toBe('💼')
    const m2 = withLogo(m1, 'group', '工作', '')!
    expect(m2.groups).toEqual({})
    expect(withLogo(emptyLogos(), 'group', '工作/金山办公', 'x')).toBeNull()
    expect(withLogo(emptyLogos(), 'entry', '个人/PyPI', 'nope.svg')).toBeNull()
  })

  it('does not mutate the input map', () => {
    const base = emptyLogos()
    withLogo(base, 'entry', 'x', '💼')
    expect(base.entries).toEqual({})
  })

  it('falls back entry -> sub-group -> group', () => {
    const m = withLogo(withLogo(emptyLogos(), 'group', '工作', '💼')!, 'sub', '工作/金山办公', '🐦')!
    expect(logoFor(m, '工作/金山办公/sre')).toBe('🐦')
    expect(logoFor(m, '工作/中化能源/OA')).toBe('💼')
    const m2 = withLogo(m, 'entry', '工作/金山办公/sre', '🔒')!
    expect(logoFor(m2, '工作/金山办公/sre')).toBe('🔒')
    expect(logoFor(emptyLogos(), '个人/PyPI')).toBe('')
  })

  it('cascades a rename, re-rooting keys underneath', () => {
    let m = withLogo(emptyLogos(), 'entry', '工作/中化能源/OA', '🔒')!
    m = withLogo(m, 'sub', '工作/中化能源', '🛢')!
    m = withLogo(m, 'entry', '工作/中化能源/WIFI-1', '📶')!
    const moved = renameLogos(m, '工作/中化能源', '工作/中化')
    expect(moved.subGroups).toEqual({ '工作/中化': '🛢' })
    expect(moved.entries).toEqual({ '工作/中化/OA': '🔒', '工作/中化/WIFI-1': '📶' })
    // an unrelated key survives untouched
    const other = withLogo(m, 'entry', '个人/PyPI', '📦')!
    expect(renameLogos(other, '工作/中化能源', '工作/中化').entries['个人/PyPI']).toBe('📦')
  })
})

describe('on-disk helpers', () => {
  it('round-trips logos.json atomically and defaults to 0600', () => {
    const dir = tempDir()
    expect(readLogosFile(dir)).toEqual(emptyLogos())   // no file yet
    const map = withLogo(emptyLogos(), 'group', '工作', '💼')!
    writeLogosFile(dir, map)
    expect(readLogosFile(dir)).toEqual(map)
    expect(readFileSync(join(dir, 'logos.json'), 'utf8')).toContain('"工作": "💼"')
    expect(existsSync(join(dir, 'logos.json.tmp'))).toBe(false)
  })

  it('recovers from a corrupt logos.json', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'logos.json'), '{ truncated')
    expect(readLogosFile(dir)).toEqual(emptyLogos())
  })

  it('creates and lists the logos directory, raster only', () => {
    const dir = tempDir()
    expect(listLogoFiles(dir)).toEqual([])             // created on demand
    mkdirSync(join(dir, 'logos'), { recursive: true })
    writeFileSync(join(dir, 'logos', 'b.png'), PNG)
    writeFileSync(join(dir, 'logos', 'a.webp'), 'x')
    writeFileSync(join(dir, 'logos', 'evil.svg'), '<svg/>')
    writeFileSync(join(dir, 'logos', 'notes.txt'), 'hi')
    expect(listLogoFiles(dir)).toEqual(['a.webp', 'b.png'])
  })
})
