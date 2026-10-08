/**
 * Client-half pure-logic tests (no DOM, no React render — the helpers that
 * drive grouping, filtering and field presentation).
 */
import { describe, expect, it } from 'vitest'
import {
  chipValues, encCount, entrySubline, fieldOrder, groupName, groupEntries,
  hostOf, hueOf, importDefaultNote, importSelectable, importSummaryText,
  importTargetName, isLinkValue, matchEntry, noteOf, orderGroups, shortName,
} from '../src/client/logic.ts'
import type { FieldMeta, ImportEntry, VaultMeta } from '../src/client/api.ts'
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
