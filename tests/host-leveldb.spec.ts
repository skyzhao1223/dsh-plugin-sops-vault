/**
 * Host-half tests for the read-only LevelDB parser (`src/host/leveldb.ts`).
 *
 * Everything here runs against synthetic fixtures written by
 * `tests/fixtures/leveldb.ts` — never against a real browser profile.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseLog, parseTable, readLevelDb, readVarint, snappyDecompress } from '../src/host/leveldb.ts'
import { encodeLog, encodeTable, snappyEncodeLiterals, varint } from './fixtures/leveldb.ts'

const text = (u: Uint8Array): string => new TextDecoder().decode(u)

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-ldb-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('varint', () => {
  it('round-trips small and multi-byte values', () => {
    for (const n of [0, 1, 127, 128, 300, 16_384, 2_147_483_647]) {
      const bytes = new Uint8Array(varint(n))
      const got = readVarint(bytes, 0)
      expect(got.value).toBe(n)
      expect(got.next).toBe(bytes.length)
    }
  })

  it('reports -1 on a truncated input', () => {
    expect(readVarint(new Uint8Array([0x80, 0x80]), 0).value).toBe(-1)
    expect(readVarint(new Uint8Array([]), 0).value).toBe(-1)
  })
})

describe('snappyDecompress', () => {
  it('round-trips a literals-only stream', () => {
    const payload = new TextEncoder().encode('a'.repeat(200) + 'OTPStorage' + 'z'.repeat(37))
    expect(text(snappyDecompress(snappyEncodeLiterals(payload)) ?? new Uint8Array())).toBe(text(payload))
  })

  it('handles a 1-byte-offset copy', () => {
    // literal "abcabc" (6 bytes), then copy len=4 offset=6 -> 10 bytes out
    const stream = new Uint8Array([10, ((6 - 1) << 2) & 0xff, 0x61, 0x62, 0x63, 0x61, 0x62, 0x63, 0x01, 0x06])
    expect(text(snappyDecompress(stream) ?? new Uint8Array())).toBe('abcabcabca')
  })

  it('handles a 2-byte-offset copy (overlapping run)', () => {
    // literal "ab", then copy len=5 offset=2 -> overlapping run "abababa"
    const stream = new Uint8Array([7, ((2 - 1) << 2) & 0xff, 0x61, 0x62, 0x02 | ((5 - 1) << 2), 0x02, 0x00])
    expect(text(snappyDecompress(stream) ?? new Uint8Array())).toBe('abababa')
  })

  it('handles an 11-bit copy offset (high bits live in the tag)', () => {
    // literal of 300 bytes, then copy len=4 offset=300 -> re-emits the first 4 bytes
    const literal = new Uint8Array(300).fill(0x61)
    literal[150] = 0x62
    const stream = new Uint8Array([
      ...varint(304),
      (61 << 2) & 0xff, 0x2b, 0x01, ...literal, // literal with a 2-byte extended length (300)
      0x21, 0x2c, // copy-1: len 4, offset = (0x20 << 3) | 0x2c = 300
    ])
    const out = snappyDecompress(stream)
    expect(out).not.toBeNull()
    expect(out!.length).toBe(304)
    expect(text(out!.subarray(300))).toBe('aaaa')
  })

  it('returns null on malformed input instead of throwing', () => {
    // claims a 5-byte literal but only one byte follows
    expect(snappyDecompress(new Uint8Array([5, ((5 - 1) << 2) & 0xff, 0x61]))).toBeNull()
    // copy whose offset points before the start of the output
    expect(snappyDecompress(new Uint8Array([10, 0x01, 0x06]))).toBeNull()
    // an empty stream is valid, not malformed
    expect(snappyDecompress(new Uint8Array([0x00]))).toEqual(new Uint8Array(0))
  })
})

describe('parseLog', () => {
  it('reads puts and deletions with their sequence numbers', () => {
    const log = encodeLog([
      [{ seq: 7, key: 'a', value: 'one' }, { seq: 7, key: 'b', value: 'two' }],
      [{ seq: 9, key: 'a', value: 'updated' }],
      [{ seq: 11, key: 'b' }],
    ])
    const records = parseLog(log)
    expect(records).toHaveLength(4)
    expect(records.map((r) => [r.seq, r.key, r.deleted, text(r.value)])).toEqual([
      [7, 'a', false, 'one'],
      [7, 'b', false, 'two'],
      [9, 'a', false, 'updated'],
      [11, 'b', true, ''],
    ])
  })

  it('survives a truncated trailing record', () => {
    const log = encodeLog([[{ seq: 3, key: 'k', value: 'v' }]])
    const torn = log.subarray(0, 20)
    expect(parseLog(torn).filter((r) => r.key === 'k')).toHaveLength(0)
    expect(parseLog(log)).toHaveLength(1)
  })
})

describe('parseTable', () => {
  it('reads entries out of an uncompressed table', () => {
    const table = encodeTable([
      { key: 'alpha', value: '{"n":1}', seq: 4 },
      { key: 'beta', value: '{"n":2}', seq: 5 },
      { key: 'gone', seq: 6 },
    ])
    const records = parseTable(table)
    expect(records.map((r) => [r.key, r.seq, r.deleted])).toEqual([
      ['alpha', 4, false],
      ['beta', 5, false],
      ['gone', 6, true],
    ])
    expect(text(records[0]!.value)).toBe('{"n":1}')
  })

  it('rejects a file without the table magic', () => {
    expect(parseTable(new Uint8Array(200))).toEqual([])
  })
})

describe('readLevelDb', () => {
  it('merges table + log by sequence number, honouring deletions', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'CURRENT'), 'MANIFEST-000001\n')
    writeFileSync(join(dir, '000004.ldb'), encodeTable([
      { key: 'stale', value: 'from-table', seq: 2 },
      { key: 'kept', value: 'table-value', seq: 2 },
      { key: 'deleted-later', value: 'x', seq: 2 },
    ]))
    writeFileSync(join(dir, '000005.log'), encodeLog([
      [{ seq: 8, key: 'stale', value: 'from-log' }],
      [{ seq: 9, key: 'deleted-later' }],
    ]))
    const db = readLevelDb(dir)
    expect([...db.keys()].sort()).toEqual(['kept', 'stale'])
    expect(text(db.get('stale')!)).toBe('from-log')
    expect(text(db.get('kept')!)).toBe('table-value')
  })

  it('returns an empty map for a missing directory', () => {
    expect(readLevelDb(join(tempDir(), 'nope')).size).toBe(0)
  })
})
