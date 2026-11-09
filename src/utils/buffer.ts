/**
 * QuickJS 沙箱内的 Buffer 兼容层。
 *
 * 宿主的 `Buffer` polyfill 只提供 from/alloc/concat/isBuffer 和 toString，没有
 * `subarray` / `indexOf` / `map` 等实例方法，而移植自 lxserver 的平台代码依赖这些
 * Node Buffer 语义。这里用 Uint8Array 子类实现一份自足的 Buffer，平台代码统一
 * `import { Buffer } from '../buffer'` 使用，避免污染宿主全局 Buffer。
 */

const HEX = '0123456789abcdef'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

import { loadGbkTable } from './gbk-table'

const textEncoder = new TextEncoder()
let gbkDecoder: ((bytes: Uint8Array) => string) | null = null

function utf8Encode(str: string): Uint8Array {
  return textEncoder.encode(str)
}

function utf8Decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    let out = ''
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i++]
      if (b < 0x80) out += String.fromCharCode(b)
      else if (b < 0xe0 && i < bytes.length) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f))
      else if (b < 0xf0 && i + 1 < bytes.length) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f))
      else if (i + 2 < bytes.length) {
        const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
        const v = cp - 0x10000
        out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
      }
    }
    return out
  }
}

function latin1Decode(bytes: Uint8Array): string {
  let out = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + chunk) as number[])
  }
  return out
}

function latin1Encode(str: string): Uint8Array {
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff
  return out
}

export function base64Encode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  if (i < bytes.length) {
    const b1 = bytes[i]
    const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const n = (b1 << 16) | (b2 << 8)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += '='
  }
  return out
}

export function base64Decode(str: string): Uint8Array {
  const clean = String(str).replace(/[^A-Za-z0-9+/]/g, '')
  const len = Math.floor((clean.length * 3) / 4)
  const out = new Uint8Array(len)
  let p = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n1 = B64.indexOf(clean[i])
    const n2 = B64.indexOf(clean[i + 1])
    const n3 = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : -1
    const n4 = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : -1
    if (p < len) out[p++] = (n1 << 2) | (n2 >> 4)
    if (n3 >= 0 && p < len) out[p++] = ((n2 & 15) << 4) | (n3 >> 2)
    if (n4 >= 0 && p < len) out[p++] = ((n3 & 3) << 6) | n4
  }
  return out.subarray(0, p)
}

function hexEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]
  return out
}

function hexDecode(str: string): Uint8Array {
  const clean = str.length % 2 ? '0' + str : str
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(clean[i * 2], 16)
    const lo = parseInt(clean[i * 2 + 1], 16)
    out[i] = ((isNaN(hi) ? 0 : hi) << 4) | (isNaN(lo) ? 0 : lo)
  }
  return out
}

export type BufferEncoding =
  | 'utf8' | 'utf-8' | 'hex' | 'base64' | 'base64url' | 'latin1' | 'binary'
  | 'ascii' | 'ucs2' | 'ucs-2' | 'utf16le' | 'utf-16le' | 'gbk' | 'gb18030'

function normalizeEncoding(enc?: string): BufferEncoding {
  const e = String(enc || 'utf8').toLowerCase()
  if (e === 'utf-8') return 'utf8'
  if (e === 'binary') return 'latin1'
  if (e === 'ucs-2' || e === 'utf-16le') return 'utf16le'
  if (e === 'base64url') return 'base64'
  if (e === 'gb2312' || e === 'gbk') return 'gbk'
  if (e === 'gb18030') return 'gb18030'
  return e as BufferEncoding
}

function bytesFromString(str: string, enc?: string): Uint8Array {
  switch (normalizeEncoding(enc)) {
    case 'hex': return hexDecode(str)
    case 'base64': return base64Decode(str)
    case 'latin1': return latin1Encode(str)
    case 'ascii': {
      const out = new Uint8Array(str.length)
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7f
      return out
    }
    case 'ucs2':
    case 'utf16le': {
      const out = new Uint8Array(str.length * 2)
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i)
        out[i * 2] = c & 0xff
        out[i * 2 + 1] = c >> 8
      }
      return out
    }
    case 'gbk':
    case 'gb18030':
      // 编码方向极少使用；退化为 UTF-8，避免静默产出错误字节。
      return utf8Encode(str)
    default:
      return utf8Encode(str)
  }
}

function bytesToString(bytes: Uint8Array, enc?: string): string {
  switch (normalizeEncoding(enc)) {
    case 'hex': return hexEncode(bytes)
    case 'base64': return base64Encode(bytes)
    case 'latin1': return latin1Decode(bytes)
    case 'ascii': return latin1Decode(bytes).replace(/[\u0080-ÿ]/g, '')
    case 'ucs2':
    case 'utf16le': {
      let out = ''
      const len = bytes.length - (bytes.length % 2)
      for (let i = 0; i < len; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8))
      return out
    }
    case 'gbk':
    case 'gb18030': {
      if (!gbkDecoder) {
        // 延迟加载，避免主路径为 GBK 表付出启动成本。
        gbkDecoder = (b: Uint8Array) => decodeGbk(b)
      }
      return gbkDecoder(bytes)
    }
    default:
      return utf8Decode(bytes)
  }
}

// GBK 解码器在 gbk-table.ts 中实现，避免循环依赖。
let gbkTableLoader: (() => Uint16Array) | null = null
export function registerGbkTableLoader(loader: () => Uint16Array): void {
  gbkTableLoader = loader
}
registerGbkTableLoader(loadGbkTable)

function decodeGbk(bytes: Uint8Array): string {
  const table = gbkTableLoader ? gbkTableLoader() : null
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i++]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      continue
    }
    if (b === 0x80) {
      out += '€'
      continue
    }
    if (i >= bytes.length) {
      out += '�'
      break
    }
    const t = bytes[i++]
    if (!table) {
      out += '�'
      continue
    }
    const lead = b - 0x81
    let trail = t - 0x40
    if (t > 0x7f) trail -= 1
    const cp = lead >= 0 && lead < 126 && trail >= 0 && trail < 190 ? table[lead * 190 + trail] : 0
    out += cp ? String.fromCharCode(cp) : '�'
  }
  return out
}

function toBytes(value: unknown, enc?: string): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof value === 'string') return bytesFromString(value, enc)
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  if (value && typeof value === 'object') {
    const anyVal = value as { _hex?: string; length?: number }
    if (typeof anyVal._hex === 'string') return hexDecode(anyVal._hex)
    if (typeof anyVal.length === 'number') {
      const out = new Uint8Array(anyVal.length)
      for (let i = 0; i < anyVal.length; i++) out[i] = ((value as Record<number, number>)[i] || 0) & 0xff
      return out
    }
  }
  throw new TypeError('The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array')
}

/** Uint8Array 子类，补齐平台代码使用的 Node Buffer 语义。 */
export class Buffer extends Uint8Array {
  static from(value: unknown, enc?: any): Buffer {
    if (typeof value === 'string') return new Buffer(bytesFromString(value, enc))
    if (value instanceof Buffer) return new Buffer(new Uint8Array(value))
    return new Buffer(toBytes(value, enc))
  }

  static alloc(size: number, fill?: number | string): Buffer {
    const buf = new Buffer(size)
    if (fill !== undefined) {
      const f = typeof fill === 'number' ? fill : (String(fill).charCodeAt(0) || 0)
      buf.fill(f & 0xff)
    }
    return buf
  }

  static allocUnsafe(size: number): Buffer {
    return new Buffer(size)
  }

  static isBuffer(obj: unknown): boolean {
    return obj instanceof Buffer
  }

  static concat(list: ArrayLike<Uint8Array>, totalLength?: number): Buffer {
    let len = totalLength
    if (len == null) {
      len = 0
      for (let i = 0; i < list.length; i++) len += list[i] ? list[i].length : 0
    }
    const out = new Buffer(len)
    let offset = 0
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      if (!item) continue
      if (offset >= len) break
      const n = Math.min(item.length, len - offset)
      if (n <= 0) continue
      out.set(item.subarray(0, n), offset)
      offset += n
    }
    return out
  }

  static byteLength(value: unknown, enc?: string): number {
    if (typeof value === 'string') return bytesFromString(value, enc).length
    return toBytes(value).length
  }

  toString(enc?: string, start?: number, end?: number): string {
    const s = start == null ? 0 : start < 0 ? Math.max(this.length + start, 0) : start
    const e = end == null ? this.length : end < 0 ? this.length + end : end
    return bytesToString(this.subarrayRaw(s, e), enc)
  }

  /** 返回共享内存的 Buffer 视图（Node 语义）。 */
  subarray(start?: number, end?: number): Buffer {
    return this.subarrayRaw(start, end)
  }

  slice(start?: number, end?: number): Buffer {
    return this.subarrayRaw(start, end)
  }

  private subarrayRaw(start?: number, end?: number): Buffer {
    // TypedArray 的 species 构造器默认是子类自身，super.subarray 已经返回共享
    // 同一段内存的 Buffer 视图（不会复制）。
    return super.subarray(start, end) as Buffer
  }

  indexOf(value: string | number | Uint8Array, byteOffset?: number, enc?: string): number {
    const offset = byteOffset == null ? 0 : byteOffset < 0 ? Math.max(this.length + byteOffset, 0) : byteOffset
    if (typeof value === 'number') {
      for (let i = offset; i < this.length; i++) if (this[i] === (value & 0xff)) return i
      return -1
    }
    const needle = typeof value === 'string' ? Buffer.from(value, enc) : value
    if (needle.length === 0) return offset <= this.length ? offset : this.length
    const first = needle[0]
    for (let i = offset; i <= this.length - needle.length; i++) {
      if (this[i] !== first) continue
      let ok = true
      for (let j = 1; j < needle.length; j++) {
        if (this[i + j] !== needle[j]) { ok = false; break }
      }
      if (ok) return i
    }
    return -1
  }

  includes(value: string | number | Uint8Array, byteOffset?: number, enc?: string): boolean {
    return this.indexOf(value, byteOffset, enc) !== -1
  }

  equals(other: Uint8Array): boolean {
    if (!other || this.length !== other.length) return false
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false
    return true
  }

  fill(value: number | string | Uint8Array, start?: number, end?: number, enc?: string): this {
    const s = start == null ? 0 : start
    const e = end == null ? this.length : end
    if (typeof value === 'number') {
      for (let i = s; i < e; i++) this[i] = value & 0xff
    } else {
      const bytes = typeof value === 'string' ? Buffer.from(value, enc) : value
      for (let i = s; i < e; i++) this[i] = bytes[(i - s) % bytes.length]
    }
    return this
  }

  write(str: string, offset?: number, length?: number, enc?: string): number {
    const bytes = Buffer.from(str, enc)
    const off = offset == null ? 0 : offset
    const len = length == null ? bytes.length : length
    const n = Math.min(len, bytes.length, this.length - off)
    for (let i = 0; i < n; i++) this[off + i] = bytes[i]
    return n
  }

  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number {
    const ts = targetStart == null ? 0 : targetStart
    const ss = sourceStart == null ? 0 : sourceStart
    const se = sourceEnd == null ? this.length : sourceEnd
    const n = Math.min(se - ss, target.length - ts)
    for (let i = 0; i < n; i++) target[ts + i] = this[ss + i]
    return n
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.prototype.slice.call(this) as number[] }
  }
}

/** 把任意二进制输入统一转成 Uint8Array（crypto/zlib 适配层使用）。 */
export { toBytes as bufferToBytes, hexEncode, hexDecode }
