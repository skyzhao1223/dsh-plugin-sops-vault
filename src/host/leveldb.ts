/**
 * Minimal READ-ONLY LevelDB parser — just enough to recover key/value pairs
 * from a Chromium extension storage database (`Local Extension Settings/<id>`,
 * `Sync Extension Settings/<id>`) without depending on `classic-level`,
 * `level` or a native build.
 *
 * What it understands:
 * - the write-ahead log (`*.log`): 32 KiB blocks of fragmented records, each
 *   complete record being a serialized `WriteBatch` (sequence number + a list
 *   of put/delete entries).
 * - sorted-string tables (`*.ldb` / `*.sst`): footer → index block → data
 *   blocks, with the prefix-compressed restart encoding and optional Snappy
 *   block compression (a from-scratch decompressor is included below).
 *
 * What it deliberately ignores: the MANIFEST (which tables are live), CRC
 * verification, filter/meta-index blocks and BlobDB files. Ignoring the
 * MANIFEST is safe for reads because every internal key carries its own
 * sequence number: merging *all* tables plus the log and keeping the highest
 * sequence per user key reproduces the live state, including deletions, even
 * when stale compacted-away tables are still on disk.
 *
 * Everything here is pure (bytes in, records out) except {@link readLevelDb},
 * which touches the filesystem. Unit-tested in `tests/host-leveldb.spec.ts`.
 *
 * @module dsh-plugin-sops-vault/host/leveldb
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Log block size fixed by the LevelDB format. */
const LOG_BLOCK = 32_768

/** Trailing magic of a table footer (little-endian uint64). */
const TABLE_MAGIC = 0xdb4775248b80fb57n

/** Footer: two block handles + padding + 8-byte magic. */
const FOOTER_LEN = 48

/** Refuse to slurp absurd files: extension stores are kilobytes to a few MB. */
const MAX_FILE_BYTES = 96 * 1024 * 1024

/** One recovered record: `deleted` marks a tombstone. */
export interface LevelRecord {
  /** Write sequence number — higher wins when the same key appears twice. */
  seq: number
  /** True for a deletion record (no value). */
  deleted: boolean
  /** User key, UTF-8 decoded (Chromium storage keys are always text). */
  key: string
  /** Raw value bytes; empty for deletions. */
  value: Uint8Array
}

/** A varint plus the offset just past it. */
interface Varint {
  value: number
  next: number
}

/** A block handle (offset, size) plus the offset just past it. */
interface BlockHandle {
  offset: number
  size: number
  next: number
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

/**
 * Read a base-128 varint. Returns `value: -1` when the input is truncated
 * (a half-written trailing log record) so callers can stop instead of throwing.
 */
export function readVarint(buf: Uint8Array, offset: number): Varint {
  let result = 0
  let shift = 0
  let i = offset
  while (i < buf.length) {
    const b = buf[i]!
    i += 1
    result += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) return { value: result, next: i }
    shift += 7
    if (shift > 49) return { value: -1, next: i }
  }
  return { value: -1, next: i }
}

/** Read a block handle (two consecutive varints). */
function readBlockHandle(buf: Uint8Array, offset: number): BlockHandle | null {
  const a = readVarint(buf, offset)
  if (a.value < 0) return null
  const b = readVarint(buf, a.next)
  if (b.value < 0) return null
  return { offset: a.value, size: b.value, next: b.next }
}

/**
 * Decompress a raw (unframed) Snappy stream, the compression LevelDB uses for
 * table blocks. Returns null on malformed input rather than throwing: a
 * corrupt block must never take down the whole scan.
 */
export function snappyDecompress(input: Uint8Array): Uint8Array | null {
  const head = readVarint(input, 0)
  if (head.value < 0 || head.value > MAX_FILE_BYTES) return null
  const out = new Uint8Array(head.value)
  let o = 0
  let i = head.next
  while (i < input.length) {
    const tag = input[i]!
    i += 1
    if ((tag & 0x03) === 0) {
      // literal
      let n = (tag >>> 2) & 0x3f
      if (n < 60) {
        n += 1
      } else {
        const extra = n - 59
        if (i + extra > input.length) return null
        let v = 0
        for (let k = 0; k < extra; k += 1) v += input[i + k]! * 2 ** (8 * k)
        i += extra
        n = v + 1
      }
      if (i + n > input.length || o + n > out.length) return null
      out.set(input.subarray(i, i + n), o)
      i += n
      o += n
      continue
    }
    // copy: 1-byte (11-bit offset), 2-byte or 4-byte little-endian offset
    let n: number
    let off: number
    if ((tag & 0x03) === 1) {
      n = ((tag >>> 2) & 0x07) + 4
      if (i + 1 > input.length) return null
      // bits 5-7 of the tag are the HIGH 3 bits of an 11-bit offset
      off = ((tag & 0xe0) << 3) | input[i]!
      i += 1
    } else if ((tag & 0x03) === 2) {
      n = (tag >>> 2) + 1
      if (i + 2 > input.length) return null
      off = input[i]! + input[i + 1]! * 256
      i += 2
    } else {
      n = (tag >>> 2) + 1
      if (i + 4 > input.length) return null
      off = input[i]! + input[i + 1]! * 256 + input[i + 2]! * 65_536 + input[i + 3]! * 16_777_216
      i += 4
    }
    if (off <= 0 || off > o || o + n > out.length) return null
    // byte-by-byte: copies may overlap (run-length style back references)
    for (let k = 0; k < n; k += 1) out[o + k] = out[o - off + k]!
    o += n
  }
  return o === out.length ? out : null
}

/* ------------------------------------------------------------------ */
/* write-ahead log                                                     */
/* ------------------------------------------------------------------ */

/** Parse one `WriteBatch` payload into records. */
function parseWriteBatch(payload: Uint8Array, fallbackSeq: number): LevelRecord[] {
  if (payload.length < 12) return []
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const seq = Number(view.getBigUint64(0, true))
  const count = view.getUint32(8, true)
  const out: LevelRecord[] = []
  let i = 12
  for (let n = 0; n < count; n += 1) {
    if (i >= payload.length) break
    const type = payload[i]!
    i += 1
    const k = readVarint(payload, i)
    if (k.value < 0 || i + k.value > payload.length) break
    i = k.next
    const keyBytes = payload.subarray(i, i + k.value)
    i += k.value
    let value: Uint8Array = new Uint8Array(0)
    let deleted = type === 0x00
    if (!deleted) {
      const v = readVarint(payload, i)
      if (v.value < 0 || i + v.value > payload.length) break
      i = v.next
      value = payload.subarray(i, i + v.value)
      i += v.value
    }
    out.push({ seq: seq > 0 ? seq : fallbackSeq, deleted, key: Buffer.from(keyBytes).toString('utf8'), value })
  }
  return out
}

/**
 * Parse a LevelDB write-ahead log: 32 KiB blocks, each holding whole or
 * fragmented records (`FULL`/`FIRST`/`MIDDLE`/`LAST`), each complete record a
 * `WriteBatch`. A trailing torn record (browser killed mid-write) is dropped.
 */
export function parseLog(buf: Uint8Array): LevelRecord[] {
  const out: LevelRecord[] = []
  let seqHint = 0
  for (let base = 0; base + 7 <= buf.length; base += LOG_BLOCK) {
    const end = Math.min(base + LOG_BLOCK, buf.length)
    let i = base
    let partial: Uint8Array | null = null
    while (i + 7 <= end) {
      const view = new DataView(buf.buffer, buf.byteOffset + i, 7)
      const length = view.getUint16(4, true)
      const type = buf[i + 6]!
      i += 7
      if (type === 0x00) {
        // padding to the end of the block
        i = end
        continue
      }
      if (i + length > end) break
      const payload = buf.subarray(i, i + length)
      i += length
      let record: Uint8Array | null = null
      if (type === 0x01) record = payload
      else if (type === 0x02) partial = payload
      else if (type === 0x03 && partial !== null) partial = concat(partial, payload)
      else if (type === 0x04 && partial !== null) {
        record = concat(partial, payload)
        partial = null
      }
      if (record !== null) {
        seqHint += 1
        out.push(...parseWriteBatch(record, seqHint))
      }
    }
  }
  return out
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/* ------------------------------------------------------------------ */
/* sorted-string tables                                                */
/* ------------------------------------------------------------------ */

/**
 * Parse one (already decompressed) block body: prefix-compressed entries plus
 * the trailing restart array. Keys here are INTERNAL keys for data blocks
 * (user key + 8-byte tag) and separator keys for index blocks.
 */
function parseBlockEntries(data: Uint8Array): { key: Uint8Array; value: Uint8Array }[] {
  if (data.length < 4) return []
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const restarts = view.getUint32(data.length - 4, true)
  const limit = data.length - 4 - restarts * 4
  const out: { key: Uint8Array; value: Uint8Array }[] = []
  let key = new Uint8Array(0)
  let i = 0
  while (i < limit) {
    const shared = readVarint(data, i)
    if (shared.value < 0) break
    const nonShared = readVarint(data, shared.next)
    if (nonShared.value < 0) break
    const valueLen = readVarint(data, nonShared.next)
    if (valueLen.value < 0) break
    i = valueLen.next
    if (shared.value > key.length || i + nonShared.value + valueLen.value > limit) break
    const next = new Uint8Array(shared.value + nonShared.value)
    next.set(key.subarray(0, shared.value), 0)
    next.set(data.subarray(i, i + nonShared.value), shared.value)
    i += nonShared.value
    key = next
    out.push({ key, value: data.subarray(i, i + valueLen.value) })
    i += valueLen.value
  }
  return out
}

/** Read and (if needed) decompress the block at a handle. */
function readTableBlock(buf: Uint8Array, offset: number, size: number): Uint8Array | null {
  if (offset < 0 || size < 0 || offset + size + 1 > buf.length) return null
  const body = buf.subarray(offset, offset + size)
  const type = buf[offset + size]!
  if (type === 0x00) return body
  if (type === 0x01) return snappyDecompress(body)
  return null
}

/**
 * Parse a sorted-string table. Internal keys end with an 8-byte tag
 * (`sequence << 8 | type`), so both the write order and put/delete kind are
 * recoverable without the MANIFEST.
 */
export function parseTable(buf: Uint8Array): LevelRecord[] {
  if (buf.length < FOOTER_LEN + 1) return []
  const footerAt = buf.length - FOOTER_LEN
  const view = new DataView(buf.buffer, buf.byteOffset + footerAt, FOOTER_LEN)
  if (view.getBigUint64(FOOTER_LEN - 8, true) !== TABLE_MAGIC) return []
  const metaHandle = readBlockHandle(buf, footerAt)
  if (metaHandle === null) return []
  const indexHandle = readBlockHandle(buf, metaHandle.next)
  if (indexHandle === null) return []
  const indexBlock = readTableBlock(buf, indexHandle.offset, indexHandle.size)
  if (indexBlock === null) return []
  const out: LevelRecord[] = []
  for (const entry of parseBlockEntries(indexBlock)) {
    const handle = readBlockHandle(entry.value, 0)
    if (handle === null) continue
    const block = readTableBlock(buf, handle.offset, handle.size)
    if (block === null) continue
    for (const { key, value } of parseBlockEntries(block)) {
      if (key.length < 8) continue
      const tagView = new DataView(key.buffer, key.byteOffset + key.length - 8, 8)
      const tag = tagView.getBigUint64(0, true)
      const type = Number(tag & 0xffn)
      const seq = Number(tag >> 8n)
      out.push({
        seq,
        deleted: type === 0x00,
        key: Buffer.from(key.subarray(0, key.length - 8)).toString('utf8'),
        value,
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* directory merge                                                     */
/* ------------------------------------------------------------------ */

/** Parse one file by extension: `.log` → WAL, `.ldb`/`.sst` → table. */
export function parseLevelDbFile(path: string): LevelRecord[] {
  let buf: Uint8Array
  try {
    const size = statSync(path).size
    if (size === 0 || size > MAX_FILE_BYTES) return []
    buf = new Uint8Array(readFileSync(path))
  } catch {
    return []
  }
  if (/\.\d*\.log$|\.log$/.test(path)) return parseLog(buf)
  if (/\.ldb$|\.sst$/.test(path)) return parseTable(buf)
  return []
}

/**
 * Read every live key/value pair out of a LevelDB directory.
 *
 * Files are read newest-content-wins by sequence number, so a concurrent
 * Chromium compaction (or a file vanishing mid-scan) degrades to fewer
 * records instead of an error. Deletions beat older puts.
 *
 * @param dir - a LevelDB directory (contains `CURRENT`, `*.log`, maybe `*.ldb`).
 * @returns user key → value bytes (deleted keys absent).
 */
export function readLevelDb(dir: string): Map<string, Uint8Array> {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return new Map()
  }
  const best = new Map<string, LevelRecord>()
  const files = names
    .filter((n) => /\.log$|\.ldb$|\.sst$/.test(n))
    .sort((a, b) => Number(a.slice(0, 6)) - Number(b.slice(0, 6)))
  for (const name of files) {
    for (const rec of parseLevelDbFile(join(dir, name))) {
      const prev = best.get(rec.key)
      if (prev === undefined || rec.seq >= prev.seq) best.set(rec.key, rec)
    }
  }
  const out = new Map<string, Uint8Array>()
  for (const [key, rec] of best) if (!rec.deleted) out.set(key, rec.value)
  return out
}
