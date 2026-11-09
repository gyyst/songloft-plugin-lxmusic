/**
 * 手写 ZIP 解析器（QuickJS 环境无第三方库）。
 *
 * 支持 STORE(0) 与 DEFLATE(8)，优先读中央目录；中央目录损坏时退回扫描
 * local file header。DEFLATE 走宿主的 __go_raw_inflate（无 zlib 头）。
 */
import { Buffer } from './buffer'
import { looksLikeZip } from './text'

export interface ZipEntry {
  name: string
  data: Uint8Array
  size: number
}

const MAX_ENTRY_SIZE = 8 * 1024 * 1024
const MAX_TOTAL_SIZE = 32 * 1024 * 1024

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function decodeName(bytes: Uint8Array): string {
  const utf8 = new Buffer(bytes).toString('utf8')
  if (utf8.indexOf('�') === -1) return utf8
  try {
    return new Buffer(bytes).toString('gb18030') || utf8
  } catch {
    return utf8
  }
}

function inflateRaw(data: Uint8Array): Uint8Array {
  const hex = __go_raw_inflate(Buffer.from(data).toString('hex'))
  const out = Buffer.from(hex, 'hex')
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 65557)
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i
  }
  return -1
}

function extractEntry(
  bytes: Uint8Array,
  name: string,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
  dataStart: number,
  total: { value: number },
): ZipEntry | null {
  if (!name || name.endsWith('/')) return null
  if (compressedSize <= 0) return null
  if (uncompressedSize > MAX_ENTRY_SIZE) throw new Error(`ZIP 条目过大: ${name}`)
  const end = dataStart + compressedSize
  if (dataStart < 0 || end > bytes.length) throw new Error(`ZIP 条目越界: ${name}`)
  const compressed = bytes.subarray(dataStart, end)
  let data: Uint8Array
  if (method === 0) {
    data = new Uint8Array(compressed)
  } else if (method === 8) {
    data = inflateRaw(compressed)
  } else {
    throw new Error(`不支持的 ZIP 压缩方式 ${method}: ${name}`)
  }
  if (data.length > MAX_ENTRY_SIZE) throw new Error(`ZIP 条目解压后过大: ${name}`)
  total.value += data.length
  if (total.value > MAX_TOTAL_SIZE) throw new Error('ZIP 解压后总大小超过限制（32MB）')
  return { name, data, size: data.length }
}

function unzipCentral(bytes: Uint8Array, eocd: number): ZipEntry[] {
  const count = readU16(bytes, eocd + 10)
  const cdOffset = readU32(bytes, eocd + 16)
  if (!count || cdOffset >= bytes.length) return []
  const entries: ZipEntry[] = []
  const total = { value: 0 }
  let pos = cdOffset
  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length) break
    if (readU32(bytes, pos) !== 0x02014b50) break
    const method = readU16(bytes, pos + 10)
    const compressedSize = readU32(bytes, pos + 20)
    const uncompressedSize = readU32(bytes, pos + 24)
    const nameLen = readU16(bytes, pos + 28)
    const extraLen = readU16(bytes, pos + 30)
    const commentLen = readU16(bytes, pos + 32)
    const localOffset = readU32(bytes, pos + 42)
    if (pos + 46 + nameLen > bytes.length) break
    const name = decodeName(bytes.subarray(pos + 46, pos + 46 + nameLen)).replace(/\\/g, '/')
    pos += 46 + nameLen + extraLen + commentLen

    if (localOffset + 30 > bytes.length) continue
    if (readU32(bytes, localOffset) !== 0x04034b50) continue
    const localNameLen = readU16(bytes, localOffset + 26)
    const localExtraLen = readU16(bytes, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const entry = extractEntry(bytes, name, method, compressedSize, uncompressedSize, dataStart, total)
    if (entry) entries.push(entry)
  }
  return entries
}

function unzipLocal(bytes: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = []
  const total = { value: 0 }
  let pos = 0
  while (pos + 30 <= bytes.length) {
    // 找下一个 local file header
    while (pos + 4 <= bytes.length && readU32(bytes, pos) !== 0x04034b50) pos++
    if (pos + 30 > bytes.length) break
    const method = readU16(bytes, pos + 8)
    const compressedSize = readU32(bytes, pos + 18)
    const uncompressedSize = readU32(bytes, pos + 22)
    const nameLen = readU16(bytes, pos + 26)
    const extraLen = readU16(bytes, pos + 28)
    if (pos + 30 + nameLen > bytes.length) break
    const name = decodeName(bytes.subarray(pos + 30, pos + 30 + nameLen)).replace(/\\/g, '/')
    const dataStart = pos + 30 + nameLen + extraLen
    if (compressedSize > 0) {
      try {
        const entry = extractEntry(bytes, name, method, compressedSize, uncompressedSize, dataStart, total)
        if (entry) entries.push(entry)
      } catch (err) {
        // 单个损坏条目跳过，继续扫描
      }
      pos = dataStart + compressedSize
    } else {
      // 数据描述符模式无法可靠取得压缩长度，跳过该条目。
      pos = dataStart
    }
  }
  return entries
}

/** 解压 ZIP，返回所有文件条目（目录/隐藏元数据也会返回，由调用方过滤）。 */
export function unzip(bytes: Uint8Array): ZipEntry[] {
  if (!looksLikeZip(bytes)) throw new Error('不是有效的 ZIP 文件')
  const eocd = findEocd(bytes)
  if (eocd >= 0) {
    try {
      const entries = unzipCentral(bytes, eocd)
      if (entries.length) return entries
    } catch (err) {
      songloft.log.warn('ZIP 中央目录解析失败，尝试扫描 local header: ' + String((err as Error)?.message || err))
    }
  }
  return unzipLocal(bytes)
}

/** 判断 ZIP 条目是否是音源脚本。 */
export function isSourceScriptEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.endsWith('/')) return false
  if (normalized.startsWith('__MACOSX/') || normalized.includes('/__MACOSX/')) return false
  const base = normalized.split('/').pop() || ''
  if (!base || base === '.DS_Store' || base.startsWith('._')) return false
  return /\.js$/i.test(base)
}
