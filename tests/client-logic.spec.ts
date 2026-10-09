/**
 * Client-half pure-logic tests (no DOM, no React render — the helpers that
 * drive grouping, filtering and field presentation).
 */
import { describe, expect, it } from 'vitest'
import { entryKinds,
  chipValues, codeCountdown, countByKind, displayCode, encCount, entrySubline,
  isEmojiLogo, logoKind, logoLookup, logoSrc, leafName,
  subGroupName, subGroupsOf,
  fieldOrder, groupName, groupEntries, hasKind, hostOf, hueOf, importDefaultNote,
  importSelectable, importSummaryText, importTargetName, isLinkValue, kindsPresent,
  matchEntry, namesOfKind, noteOf, orderGroups, shortName,
} from '../src/client/logic.ts'
import type { FieldMeta, ImportEntry, LogoMap, VaultMeta } from '../src/client/api.ts'
import { makeT } from '../src/client/i18n.ts'

const plain = (value: string): FieldMeta => ({ enc: false, value })
const enc = (): FieldMeta => ({ enc: true })

const FIELDS: Record<string, FieldMeta> = {
  url: plain('https://vpn.example.com'),
  username: plain('zhangsan'),
  password: enc(),
  apiv3_key: enc(),
  appid: plain('wx8888888888888888'),
  env: plain('prod'),
  owner: plain('ops'),
  note: plain('需先连办公网'),
  totp: enc(),
  token: { enc: false, value: '' },
}

describe('name helpers', () => {
  it('splits group and short name', () => {
    expect(groupName('工作/公司VPN')).toBe('工作')
    expect(groupName('裸名字')).toBe('')
    expect(shortName('工作/公司VPN')).toBe('公司VPN')
    expect(shortName('裸名字')).toBe('裸名字')
  })

  it('orders known groups first', () => {
    expect(orderGroups(['生活', '服务', '其它', '工作'])).toEqual(['工作', '服务', '生活', '其它'])
  })

  it('hueOf is deterministic and in range', () => {
    const a = hueOf('工作/公司VPN')
    expect(a).toBe(hueOf('工作/公司VPN'))
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(360)
  })
})

describe('value helpers', () => {
  it('hostOf extracts hostname', () => {
    expect(hostOf('https://vpn.example.com/x')).toBe('vpn.example.com')
    expect(hostOf('mysql://db:3306')).toBe('')
    expect(hostOf('')).toBe('')
  })

  it('isLinkValue only matches http(s)', () => {
    expect(isLinkValue('https://x')).toBe(true)
    expect(isLinkValue('ftp://x')).toBe(false)
  })

  it('encCount counts encrypted fields', () => {
    expect(encCount(FIELDS)).toBe(3)
  })

  it('entrySubline prefers URL host, then appid, then username', () => {
    expect(entrySubline(FIELDS)).toBe('vpn.example.com')
    expect(entrySubline({ appid: plain('wx1'), username: plain('u') })).toBe('wx1')
    expect(entrySubline({ username: plain('u') })).toBe('u')
    expect(entrySubline({ password: enc() })).toBe('')
  })

  it('chips and note read the chrome fields', () => {
    expect(chipValues(FIELDS)).toEqual({ env: 'prod', owner: 'ops' })
    expect(chipValues({})).toEqual({ env: '', owner: '' })
    expect(noteOf(FIELDS)).toBe('需先连办公网')
    expect(noteOf({})).toBe('')
  })
})

describe('fieldOrder', () => {
  it('drops chrome + empty plaintext, links first, encrypted last', () => {
    expect(fieldOrder(FIELDS)).toEqual(['url', 'appid', 'username', 'apiv3_key', 'password'])
  })
})

describe('matchEntry', () => {
  it('matches name, field names and plaintext values, never encrypted values', () => {
    expect(matchEntry(FIELDS, '工作/公司VPN', 'vpn')).toBe(true)
    expect(matchEntry(FIELDS, 'x', 'zhangsan')).toBe(true)
    expect(matchEntry(FIELDS, 'x', 'appid')).toBe(true)
    expect(matchEntry(FIELDS, 'x', '')).toBe(true)
    expect(matchEntry(FIELDS, 'x', '不存在的词')).toBe(false)
  })
})

describe('groupEntries', () => {
  it('groups visible entries in preferred order', () => {
    const meta: VaultMeta = {
      '生活/电商': { url: plain('https://shop') },
      '工作/VPN': FIELDS,
      '服务/支付': { appid: plain('wx1') },
    }
    const grouped = groupEntries(meta, Object.keys(meta))
    expect(grouped.map(([g]) => g)).toEqual(['工作', '服务', '生活'])
    expect(grouped[0]![1]).toEqual(['工作/VPN'])
  })

  it('uses the caller-supplied fallback for ungrouped entries', () => {
    const meta: VaultMeta = { '裸名字': { url: plain('https://x') } }
    expect(groupEntries(meta, ['裸名字'], 'Ungrouped')[0]![0]).toBe('Ungrouped')
    expect(groupEntries(meta, ['裸名字'], '未分组')[0]![0]).toBe('未分组')
  })
})

describe('import helpers', () => {
  const entry = (over: Partial<ImportEntry> = {}): ImportEntry => ({
    id: 'e1', source: 0, issuer: '', account: '', type: 'totp', digits: 6, period: 30,
    algorithm: 'sha1', counter: 0, secretLen: 32, encrypted: false, usable: true,
    reason: '', suggest: 'GitHub', url: '', exists: false, ...over,
  })
  const stubT = (k: string, p?: Record<string, string | number>): string =>
    p === undefined ? k : `${k}{${Object.entries(p).map(([a, b]) => `${a}=${String(b)}`).join(',')}}`

  it('joins prefix and suggested name, tolerating stray slashes', () => {
    expect(importTargetName('工作', 'GitHub')).toBe('工作/GitHub')
    expect(importTargetName('工作/服务', 'GitHub')).toBe('工作/服务/GitHub')
    expect(importTargetName('', 'GitHub')).toBe('GitHub')
    expect(importTargetName('   ', 'GitHub')).toBe('GitHub')
    expect(importTargetName('/工作/', '/GitHub/')).toBe('工作/GitHub')
    expect(importTargetName('工作', '  ')).toBe('')
  })

  it('assembles the note from the parts it has', () => {
    expect(importDefaultNote('KSO-Jumpserver', 'zhaotian1', 'chrome/Default', '2026-10-08'))
      .toBe('Authenticator 导入 2026-10-08 · chrome/Default · issuer=KSO-Jumpserver · account=zhaotian1')
    expect(importDefaultNote('KSO-Jumpserver', '', 'chrome/Default', '2026-10-08'))
      .toBe('Authenticator 导入 2026-10-08 · chrome/Default · issuer=KSO-Jumpserver')
    expect(importDefaultNote('', 'zhaotian1', '', '2026-10-08'))
      .toBe('Authenticator 导入 2026-10-08 · account=zhaotian1')
    expect(importDefaultNote('', '', '', '')).toBe('Authenticator 导入')
  })

  it('summarizes an applied import on one line', () => {
    expect(importSummaryText(['a', 'b'], [], stubT)).toBe('importSumOk{n=2}')
    expect(importSummaryText(['a'], [{ name: 'x', reason: 'r' }], stubT))
      .toBe('importSumOk{n=1} · importSumSkip{n=1,first=x}')
    expect(importSummaryText([], [{ name: 'x', reason: 'r' }, { name: 'y', reason: 'r' }], stubT))
      .toBe('importSumNone · importSumSkip{n=2,first=x}')
    expect(importSummaryText([], [], stubT)).toBe('importSumNone')
  })

  it('resolves its copy keys in both dictionaries', () => {
    for (const lang of ['zh', 'en'] as const) {
      const tr = makeT(lang) as (k: string, p?: Record<string, string | number>) => string
      const s = importSummaryText(['a'], [{ name: 'x', reason: 'r' }], tr)
      expect(s).not.toContain('importSum')
      expect(s).toContain('1')
    }
  })

  it('keeps only usable, not-yet-present entries selectable', () => {
    const list = [
      entry({ id: 'ok' }),
      entry({ id: 'dup', exists: true }),
      entry({ id: 'bad', usable: false, reason: '种子缺失' }),
    ]
    expect(importSelectable(list).map((e) => e.id)).toEqual(['ok'])
    expect(importSelectable([])).toEqual([])
  })
})

describe('data-kind filtering', () => {
  const totpEntry: Record<string, FieldMeta> = { url: plain('https://a.example'), username: plain('me'), totp: enc() }
  const emptyTotp: Record<string, FieldMeta> = { totp: plain('') }
  const pwEntry: Record<string, FieldMeta> = { password: enc(), note: plain('x') }
  const keyEntry: Record<string, FieldMeta> = { appkey: enc(), token: enc() }
  const plainOnly: Record<string, FieldMeta> = { url: plain('https://b.example'), env: plain('prod') }

  it('totp needs an ENCRYPTED totp field', () => {
    expect(hasKind(totpEntry, 'totp')).toBe(true)
    expect(hasKind(emptyTotp, 'totp')).toBe(false)
    expect(hasKind(pwEntry, 'totp')).toBe(false)
  })

  it('password and secret are distinct kinds, and secret ignores totp/password', () => {
    expect(hasKind(pwEntry, 'password')).toBe(true)
    expect(hasKind(pwEntry, 'secret')).toBe(false)
    expect(hasKind(totpEntry, 'secret')).toBe(false)
    expect(hasKind(keyEntry, 'secret')).toBe(true)
    expect(hasKind(keyEntry, 'password')).toBe(false)
  })

  it('plaintext-only entries belong to no kind', () => {
    expect(hasKind(plainOnly, 'totp')).toBe(false)
    expect(hasKind(plainOnly, 'password')).toBe(false)
    expect(hasKind(plainOnly, 'secret')).toBe(false)
  })

  const META: VaultMeta = { '工作/VPN': totpEntry, '个人/PyPI': totpEntry, '服务/npmjs': keyEntry, '其它/empty': emptyTotp }

  it('counts entries per kind and only offers non-empty chips', () => {
    expect(countByKind(META)).toEqual({ totp: 2, password: 0, secret: 1 })
    expect(kindsPresent(META)).toEqual(['totp', 'secret'])
    expect(kindsPresent({})).toEqual([])
  })

  it('lists the names of one kind in vault order', () => {
    expect(namesOfKind(META, 'totp')).toEqual(['工作/VPN', '个人/PyPI'])
    expect(namesOfKind(META, 'secret')).toEqual(['服务/npmjs'])
    expect(namesOfKind(META, 'password')).toEqual([])
  })
})

describe('live-code countdown', () => {
  it('ticks down and clamps at zero', () => {
    expect(codeCountdown(30, 0)).toEqual({ left: 30, frac: 1, expired: false })
    expect(codeCountdown(30, 12).left).toBe(18)
    expect(codeCountdown(30, 29)).toEqual({ left: 1, frac: 1 / 30, expired: false })
    expect(codeCountdown(30, 30)).toEqual({ left: 0, frac: 0, expired: true })
    expect(codeCountdown(30, 45)).toEqual({ left: 0, frac: 0, expired: true })
  })

  it('falls back to a 30 s window for a non-positive remain', () => {
    expect(codeCountdown(0, 5).left).toBe(25)
    expect(codeCountdown(-3, 0)).toEqual({ left: 30, frac: 1, expired: false })
  })

  it('groups a 6-digit code for display and leaves anything else alone', () => {
    expect(displayCode('123456')).toBe('123 456')
    expect(displayCode('12345678')).toBe('12345678')
    expect(displayCode('12345')).toBe('12345')
    expect(displayCode('')).toBe('')
  })
})

describe('entryKinds (row type badges)', () => {
  it('returns kinds in display order for a mixed entry', () => {
    expect(entryKinds({
      password: { enc: true },
      appsecret: { enc: true },
      totp: { enc: true },
      url: { enc: false, value: 'https://x' },
    })).toEqual(['password', 'secret', 'totp'])
  })
  it('classifies api-credential entries as secret only', () => {
    expect(entryKinds({ appid: { enc: false, value: 'wx1' }, appsecret: { enc: true } })).toEqual(['secret'])
  })
  it('ignores empty plaintext fields', () => {
    expect(entryKinds({ password: { enc: false, value: '' }, totp: { enc: false, value: '' }, note: { enc: false, value: 'n' } })).toEqual([])
  })
})

describe('company sub-grouping (3-segment entry names)', () => {
  it('reads the second segment as the sub-group', () => {
    expect(subGroupName('工作/中化能源/OA')).toBe('中化能源')
    expect(subGroupName('工作/金山办公/sre')).toBe('金山办公')
    expect(subGroupName('个人/PyPI')).toBe('')
    expect(subGroupName('裸名')).toBe('')
    expect(subGroupName('工作/中化能源/子/更深')).toBe('中化能源')
  })

  it('leafName is what a row shows once its sub-group has a header', () => {
    expect(leafName('工作/中化能源/OA')).toBe('OA')
    expect(leafName('个人/PyPI')).toBe('PyPI')
    expect(leafName('裸名')).toBe('裸名')
    expect(leafName('工作/中化能源/蓝湖-公用账户1')).toBe('蓝湖-公用账户1')
  })

  it('buckets a group by company, named sub-groups first and "" last', () => {
    const names = ['工作/中化能源/OA', '工作/金山办公/sre', '工作/中化能源/堡垒机', '工作/直属条目']
    const got = subGroupsOf(names)
    // collation of two CJK names follows the runtime locale, so assert the
    // bucketing and the ""-last rule rather than a fixed company order
    expect(got.map(([sub]) => sub).filter(Boolean).sort()).toEqual(['中化能源', '金山办公'].sort())
    expect(got[got.length - 1]![0]).toBe('')
    expect(Object.fromEntries(got)).toEqual({
      '中化能源': ['工作/中化能源/OA', '工作/中化能源/堡垒机'],
      '金山办公': ['工作/金山办公/sre'],
      '': ['工作/直属条目'],
    })
  })

  it('returns a single headerless bucket when nobody has a sub-group', () => {
    expect(subGroupsOf(['个人/PyPI', '个人/Mapbox'])).toEqual([['', ['个人/PyPI', '个人/Mapbox']]])
    expect(subGroupsOf([])).toEqual([])
  })
})

describe('logo config', () => {
  const empty: LogoMap = { version: 1, groups: {}, subGroups: {}, entries: {} }

  it('classifies the four renderable forms and rejects the rest', () => {
    expect(logoKind('💼')).toBe('text')
    expect(logoKind('金')).toBe('text')
    expect(logoKind('wps.png')).toBe('file')
    expect(logoKind('a-b.1@x.webp')).toBe('file')
    expect(logoKind('https://x.example/y.png')).toBe('url')
    expect(logoKind('data:image/png;base64,AAA')).toBe('data')
    expect(logoKind('')).toBe('none')
    expect(logoKind(undefined)).toBe('none')
    expect(logoKind('../evil.png')).toBe('none')
    expect(logoKind('/abs/x.png')).toBe('none')
    expect(logoKind('.hidden.png')).toBe('none')
    expect(logoKind('logo.svg')).toBe('none')
    expect(logoKind('a/b.png')).toBe('none')
    expect(logoKind('supercalifragilistic')).toBe('none')
  })

  it('builds the src: local files go through the host route', () => {
    expect(logoSrc('wps.png')).toBe('/vault-api/logo/wps.png')
    expect(logoSrc('a@b_c.1-x.png')).toBe('/vault-api/logo/a%40b_c.1-x.png')
    // a space is not a legal logo file name on the host either (safeLogoName),
    // so the client must not try to render it
    expect(logoSrc('a b.png')).toBe('')
    expect(logoSrc('https://x/y.png')).toBe('https://x/y.png')
    expect(logoSrc('data:image/gif;base64,AA')).toBe('data:image/gif;base64,AA')
    expect(logoSrc('💼')).toBe('')
    expect(logoSrc('logo.svg')).toBe('')
  })

  it('looks up entry -> sub-group -> group, and never invents a logo', () => {
    const map: LogoMap = {
      version: 1,
      groups: { '工作': '💼', '个人': '🏠' },
      subGroups: { '工作/金山办公': 'wps.png' },
      entries: { '工作/金山办公/sre': '🔒' },
    }
    expect(logoLookup(map, 'entry', '工作/金山办公/sre')).toBe('🔒')
    expect(logoLookup(map, 'entry', '工作/金山办公/ksogit')).toBe('wps.png')
    expect(logoLookup(map, 'entry', '工作/中化能源/OA')).toBe('💼')
    expect(logoLookup(map, 'entry', '个人/PyPI')).toBe('🏠')
    expect(logoLookup(map, 'group', '工作')).toBe('💼')
    expect(logoLookup(map, 'sub', '工作/中化能源')).toBe('')
    expect(logoLookup(map, 'entry', '服务/npmjs')).toBe('')
    expect(logoLookup(null, 'entry', '工作/金山办公/sre')).toBe('')
    expect(logoLookup(empty, 'group', '工作')).toBe('')
  })

  it('tells an emoji apart from a letter tile', () => {
    expect(isEmojiLogo('💼')).toBe(true)
    expect(isEmojiLogo('⚙️')).toBe(true)
    expect(isEmojiLogo('金')).toBe(false)
    expect(isEmojiLogo('W')).toBe(false)
    expect(isEmojiLogo('AB')).toBe(false)
    expect(isEmojiLogo('')).toBe(false)
  })
})
