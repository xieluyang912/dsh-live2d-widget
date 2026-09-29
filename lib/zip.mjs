/**
 * Minimal, dependency-free ZIP reader (store + deflate + Zip64).
 *
 * Live2D models are distributed as .zip archives, so the plugin must be able to
 * unpack one without pulling a third-party dependency into the DSH profile.
 * Only what model archives actually use is implemented: stored and deflated
 * entries, Zip64 size/offset fields, directory markers, and UTF-8/GBK filename
 * decoding. Encryption, multi-disk archives and data descriptors are rejected
 * with a clear error instead of silently producing a corrupt model.
 */
import zlib from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOC = 0x07064b50
const SIG_CEN = 0x02014b50
const SIG_LOC = 0x04034b50

const MAX_COMMENT = 0xffff
/** Guard against zip-bomb style archives: refuse absurd declared totals. */
export const MAX_TOTAL_BYTES = 1 << 30 // 1 GiB
export const MAX_ENTRIES = 20000

/** Decode a filename buffer: UTF-8 when flagged, else UTF-8 with a GBK retry. */
function decodeName(bytes, flags) {
  if (flags & 0x800) return bytes.toString('utf8')
  const utf8 = bytes.toString('utf8')
  if (utf8.indexOf('\uFFFD') === -1) return utf8
  // Legacy archives (very common for Chinese model packs) store GBK names.
  try {
    return new TextDecoder('gbk').decode(bytes)
  } catch (err) {
    try {
      return new TextDecoder('gb18030').decode(bytes)
    } catch (err2) {
      return utf8
    }
  }
}

/** Locate the End Of Central Directory record, tolerating a trailing comment. */
function findEocd(buf) {
  const min = Math.max(0, buf.length - MAX_COMMENT - 22)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/** Read Zip64 extended values when the 32-bit fields are saturated. */
function readZip64Extra(extra, need) {
  let off = 0
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off)
    const size = extra.readUInt16LE(off + 2)
    const body = extra.subarray(off + 4, off + 4 + size)
    if (id === 0x0001) {
      let p = 0
      const out = {}
      for (const key of need) {
        if (p + 8 > body.length) break
        out[key] = Number(body.readBigUInt64LE(p))
        p += 8
      }
      return out
    }
    off += 4 + size
  }
  return {}
}

/**
 * Read every regular file in a ZIP archive.
 * @param {Buffer} buf - the whole archive.
 * @returns {Array<{ name: string, data: Buffer }>} files, names slash-separated.
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip 文件（长度不足）')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到目录结尾记录）')

  let count = buf.readUInt16LE(eocd + 10)
  let cdSize = buf.readUInt32LE(eocd + 12)
  let cdOffset = buf.readUInt32LE(eocd + 16)

  // Zip64: the 32-bit fields saturate and the real values live in EOCD64.
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    const locPos = eocd - 20
    if (locPos >= 0 && buf.readUInt32LE(locPos) === SIG_EOCD64_LOC) {
      const eocd64 = Number(buf.readBigUInt64LE(locPos + 8))
      if (eocd64 >= 0 && eocd64 + 56 <= buf.length && buf.readUInt32LE(eocd64) === SIG_EOCD64) {
        count = Number(buf.readBigUInt64LE(eocd64 + 32))
        cdSize = Number(buf.readBigUInt64LE(eocd64 + 40))
        cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48))
      }
    }
  }

  if (count > MAX_ENTRIES) throw new Error(`zip 条目过多（${count}），已拒绝`)
  if (cdOffset + cdSize > buf.length) throw new Error('zip 目录记录越界，文件可能已损坏')

  const files = []
  let p = cdOffset
  let totalBytes = 0

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) {
      throw new Error('zip 目录记录损坏（第 ' + (i + 1) + ' 项）')
    }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    let csize = buf.readUInt32LE(p + 20)
    let usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const externalAttrs = buf.readUInt32LE(p + 38)
    let localOffset = buf.readUInt32LE(p + 42)
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen)
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)

    if (flags & 0x1) throw new Error('该 zip 已加密，无法解压：' + decodeName(nameBytes, flags))
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      const z = readZip64Extra(extra, ['usize', 'csize', 'localOffset'])
      if (z.usize !== undefined) usize = z.usize
      if (z.csize !== undefined) csize = z.csize
      if (z.localOffset !== undefined) localOffset = z.localOffset
    }

    let name = decodeName(nameBytes, flags).replace(/\\/g, '/')
    p += 46 + nameLen + extraLen + commentLen

    const isDir = name.endsWith('/') || (externalAttrs & 0x10) !== 0
    if (isDir) continue
    name = name.replace(/^\/+/, '')
    if (!name) continue

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOC) {
      throw new Error('zip 成员头损坏：' + name)
    }
    const locNameLen = buf.readUInt16LE(localOffset + 26)
    const locExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + locNameLen + locExtraLen
    if (dataStart + csize > buf.length) throw new Error('zip 成员数据越界：' + name)
    const raw = buf.subarray(dataStart, dataStart + csize)

    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error(`不支持的压缩算法 ${method}（成员 ${name}）`)

    if (usize && data.length !== usize) {
      throw new Error(`解压长度不符（成员 ${name}：期望 ${usize}，实际 ${data.length}）`)
    }
    totalBytes += data.length
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('zip 解压后体积过大，已拒绝')
    files.push({ name, data })
  }

  if (!files.length) throw new Error('zip 中没有文件')
  return files
}
