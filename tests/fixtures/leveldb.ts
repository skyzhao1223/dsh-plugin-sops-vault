/**
 * Synthetic LevelDB writers for tests.
 *
 * The parser under test has to work against Chromium's on-disk format, so the
 * fixtures below *encode* that format by hand (log blocks, a block-based table
 * with an index block and a footer, plus a literals-only Snappy stream). No
 * real browser profile is ever read by the test suite.
 *
 * @module dsh-plugin-sops-vault/tests/fixtures/leveldb
 */

/** Write a base-128 varint. */
export function varint(value: number): number[] {
  const out: number[] = []
  let v = value
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

/** Encode a 64-bit little-endian tag (`sequence << 8 | type`) as internal-key suffix. */
export function internalTag(seq: number, type: 0 | 1): number[] {
  const tag = BigInt(seq) * 256n + BigInt(type)
  const out: number[] = []
  for (let i = 0; i < 8; i += 1) out.push(Number((tag >> BigInt(8 * i)) & 0xffn))
  return out
}

/** One record to place in a synthetic write-ahead log. */
export interface LogPut {
  seq: number
  key: string
  /** Omit for a deletion. */
  value?: string
}

/**
 * Build one complete log file image: a single 32 KiB block holding one FULL
 * record per batch. CRCs are zero-filled — the parser does not verify them.
 */
export function encodeLog(batches: readonly (readonly LogPut[])[]): Uint8Array {
  const block = new Uint8Array(32_768)
  let at = 0
  for (const batch of batches) {
    const seq = batch[0]?.seq ?? 1
    // 8-byte sequence (LE) + 4-byte count (LE) + records
    const body: number[] = []
    let s = seq
    for (let i = 0; i < 8; i += 1) {
      body.push(s & 0xff)
      s = Math.floor(s / 256)
    }
    let count = batch.length
    for (let i = 0; i < 4; i += 1) {
      body.push(count & 0xff)
      count = Math.floor(count / 256)
    }
    for (const rec of batch) {
      const kb = [...new TextEncoder().encode(rec.key)]
      body.push(rec.value === undefined ? 0x00 : 0x01, ...varint(kb.length), ...kb)
      if (rec.value !== undefined) {
        const vb = [...new TextEncoder().encode(rec.value)]
        body.push(...varint(vb.length), ...vb)
      }
    }
    const header = [0, 0, 0, 0, body.length & 0xff, (body.length >> 8) & 0xff, 0x01]
    block.set(header, at)
    at += 7
    block.set(body, at)
    at += body.length
  }
  return block
}

/** Encode a block body: prefix-compressed entries + a one-restart trailer. */
function encodeBlock(entries: readonly { key: number[]; value: number[] }[]): Uint8Array {
  const body: number[] = []
  for (const e of entries) {
    body.push(...varint(0), ...varint(e.key.length), ...varint(e.value.length), ...e.key, ...e.value)
  }
  const out = [...body, 0, 0, 0, 0, 1, 0, 0, 0] // restart offsets[1] = {0}, num_restarts = 1
  return new Uint8Array(out)
}

/**
 * Build a complete table (`.ldb`) image: one data block, one index block,
 * uncompressed, with a valid footer and magic.
 * @param entries - user keys with their sequence/type; order must be sorted by key.
 */
export function encodeTable(entries: readonly { key: string; value?: string; seq: number }[]): Uint8Array {
  const enc = new TextEncoder()
  const dataEntries = entries.map((e) => ({
    key: [...enc.encode(e.key), ...internalTag(e.seq, e.value === undefined ? 0 : 1)],
    value: e.value === undefined ? [] : [...enc.encode(e.value)],
  }))
  const data = encodeBlock(dataEntries)
  const dataOffset = 0
  const indexHandleAt = dataOffset + data.length + 5 // + type byte + 4-byte crc
  const indexBlock = encodeBlock([{
    key: [0xff, 0xff, 0xff, 0xff],
    value: [...varint(dataOffset), ...varint(data.length)],
  }])
  const indexOffset = indexHandleAt + indexBlock.length + 5
  const out = new Uint8Array(indexOffset + 48)
  out.set(data, dataOffset)
  out[dataOffset + data.length] = 0x00 // no compression
  out.set(indexBlock, indexHandleAt)
  out[indexHandleAt + indexBlock.length] = 0x00
  // footer: metaindex handle (0,0), index handle, pad to 40 bytes, magic
  const footer: number[] = [...varint(0), ...varint(0), ...varint(indexHandleAt), ...varint(indexBlock.length)]
  while (footer.length < 40) footer.push(0)
  const magic = 0xdb4775248b80fb57n
  for (let i = 0; i < 8; i += 1) footer.push(Number((magic >> BigInt(8 * i)) & 0xffn))
  out.set(new Uint8Array(footer), indexOffset)
  return out
}

/**
 * Encode a Snappy stream using literal runs only (≤60 bytes per run). Valid
 * Snappy, and enough to exercise the decompressor's literal path.
 */
export function snappyEncodeLiterals(input: Uint8Array): Uint8Array {
  const out: number[] = [...varint(input.length)]
  for (let at = 0; at < input.length; at += 60) {
    const chunk = input.subarray(at, Math.min(at + 60, input.length))
    out.push(((chunk.length - 1) << 2) & 0xff, ...chunk)
  }
  return new Uint8Array(out)
}
