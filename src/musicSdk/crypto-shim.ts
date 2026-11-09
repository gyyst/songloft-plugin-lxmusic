/**
 * 加密适配层：把 lxserver 平台代码里的 node:crypto 调用收敛到这里。
 *
 * - MD5：纯 JS 实现（宿主只提供字符串 MD5，而签名时常需要二进制输入）
 * - AES-CBC/ECB + PKCS7：走宿主原生桥接 `__go_crypto_aes_*`（Go crypto/aes）
 * - RSA：PKCS1v15 走宿主桥接；RSA_NO_PADDING（网易 weapi 需要）用 BigInt 纯 JS 实现
 * - randomBytes：宿主 `__go_crypto_random_bytes`
 */
import { Buffer, bufferToBytes, hexEncode, hexDecode } from '../utils/buffer'

// ===== MD5（纯 JS，支持任意字节） =====

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]
const MD5_K: number[] = []
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0

function md5Bytes(input: Uint8Array): Uint8Array {
  const len = input.length
  const bitLen = len * 8
  const paddedLen = (((len + 8) >> 6) + 1) << 6
  const padded = new Uint8Array(paddedLen)
  padded.set(input)
  padded[len] = 0x80
  // 长度按小端 64 位写入
  const hi = Math.floor(bitLen / 0x100000000)
  const lo = bitLen >>> 0
  padded[paddedLen - 8] = lo & 0xff
  padded[paddedLen - 7] = (lo >>> 8) & 0xff
  padded[paddedLen - 6] = (lo >>> 16) & 0xff
  padded[paddedLen - 5] = (lo >>> 24) & 0xff
  padded[paddedLen - 4] = hi & 0xff
  padded[paddedLen - 3] = (hi >>> 8) & 0xff
  padded[paddedLen - 2] = (hi >>> 16) & 0xff
  padded[paddedLen - 1] = (hi >>> 24) & 0xff

  let a0 = 0x67452301 | 0
  let b0 = 0xefcdab89 | 0
  let c0 = 0x98badcfe | 0
  let d0 = 0x10325476 | 0

  const m = new Int32Array(16)
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      m[i] = (padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24)) | 0
    }
    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F: number, g: number
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) & 15
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) & 15
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) & 15
      }
      F = (F + A + MD5_K[i] + m[g]) | 0
      A = D
      D = C
      C = B
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) | 0
    }
    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }

  const out = new Uint8Array(16)
  const words = [a0, b0, c0, d0]
  for (let i = 0; i < 4; i++) {
    const v = words[i]
    out[i * 4] = v & 0xff
    out[i * 4 + 1] = (v >>> 8) & 0xff
    out[i * 4 + 2] = (v >>> 16) & 0xff
    out[i * 4 + 3] = (v >>> 24) & 0xff
  }
  return out
}

export function md5(input: string | Uint8Array): string {
  return hexEncode(md5Bytes(typeof input === 'string' ? Buffer.from(input) : bufferToBytes(input)))
}

export function toMD5(str: string): string {
  return md5(str)
}

// ===== 哈希接口（node createHash 兼容） =====

class Hash {
  private chunks: Uint8Array[] = []
  constructor(private algorithm: string) {}

  update(data: string | Uint8Array, _enc?: string): this {
    this.chunks.push(typeof data === 'string' ? Buffer.from(data) : Buffer.from(bufferToBytes(data)))
    return this
  }

  digest(enc?: string): string | Uint8Array {
    let total = 0
    for (const c of this.chunks) total += c.length
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of this.chunks) { merged.set(c, off); off += c.length }
    const alg = this.algorithm.toLowerCase()
    let out: Uint8Array
    if (alg === 'md5') out = md5Bytes(merged)
    else if (alg === 'sha256') out = hexDecode(__go_crypto_sha256_bytes(hexEncode(merged)))
    else if (alg === 'sha1') out = hexDecode(__go_crypto_sha1(new Buffer(merged).toString('utf8')))
    else throw new Error(`unsupported hash algorithm: ${this.algorithm}`)
    return enc === 'hex' ? hexEncode(out) : new Buffer(out)
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm)
}

// ===== AES（宿主原生桥接） =====

function aesArgs(key: string | Uint8Array, iv?: string | Uint8Array | null): { keyHex: string; ivHex: string } {
  return {
    keyHex: hexEncode(bufferToBytes(key)),
    ivHex: iv == null || (typeof iv === 'string' && iv.length === 0) ? '' : hexEncode(bufferToBytes(iv)),
  }
}

export function aesEncrypt(buffer: string | Uint8Array, mode: string, key: string | Uint8Array, iv?: string | Uint8Array | null): Buffer {
  const { keyHex, ivHex } = aesArgs(key, iv)
  const normalized = String(mode).toLowerCase().includes('ecb') ? 'ecb' : 'cbc'
  const dataHex = hexEncode(bufferToBytes(buffer))
  return new Buffer(hexDecode(__go_crypto_aes_encrypt(dataHex, normalized, keyHex, ivHex)))
}

export function aesDecrypt(buffer: string | Uint8Array, mode: string, key: string | Uint8Array, iv?: string | Uint8Array | null): Buffer {
  const { keyHex, ivHex } = aesArgs(key, iv)
  const normalized = String(mode).toLowerCase().includes('ecb') ? 'ecb' : 'cbc'
  // 字符串密文默认按 base64 解析（与宿主 crypto.aesDecrypt 语义一致）。
  const bytes = typeof buffer === 'string' ? Buffer.from(buffer, 'base64') : bufferToBytes(buffer)
  return new Buffer(hexDecode(__go_crypto_aes_decrypt(hexEncode(bytes), normalized, keyHex, ivHex)))
}

class Cipher {
  private mode: 'encrypt' | 'decrypt'
  private algorithm: string
  private key: Buffer
  private iv: Buffer
  private chunks: Uint8Array[] = []

  constructor(mode: 'encrypt' | 'decrypt', algorithm: string, key: string | Uint8Array, iv?: string | Uint8Array | null) {
    this.mode = mode
    this.algorithm = algorithm
    this.key = Buffer.from(bufferToBytes(key))
    this.iv = iv == null ? Buffer.alloc(0) : Buffer.from(bufferToBytes(iv))
  }

  update(data: string | Uint8Array, _inputEnc?: string, _outputEnc?: string): Buffer {
    this.chunks.push(Buffer.from(bufferToBytes(data)))
    return Buffer.alloc(0)
  }

  final(_outputEnc?: string): Buffer {
    let total = 0
    for (const c of this.chunks) total += c.length
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of this.chunks) { merged.set(c, off); off += c.length }
    return this.mode === 'encrypt'
      ? aesEncrypt(merged, this.algorithm, this.key, this.iv)
      : aesDecrypt(merged, this.algorithm, this.key, this.iv)
  }
}

export function createCipheriv(algorithm: string, key: string | Uint8Array, iv?: string | Uint8Array | null): Cipher {
  return new Cipher('encrypt', algorithm, key, iv)
}

export function createDecipheriv(algorithm: string, key: string | Uint8Array, iv?: string | Uint8Array | null): Cipher {
  return new Cipher('decrypt', algorithm, key, iv)
}

// ===== RSA =====

export const constants = {
  RSA_NO_PADDING: 3,
  RSA_PKCS1_PADDING: 1,
}

/** 解析 PEM/裸 base64 的 SubjectPublicKeyInfo，返回 { n, e }。 */
function parseRsaPublicKey(key: string): { n: bigint; e: bigint } {
  let b64 = String(key)
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  const der = Buffer.from(b64, 'base64')

  let pos = 0
  function readLen(): number {
    let l = der[pos++]
    if (l & 0x80) {
      const n = l & 0x7f
      l = 0
      for (let i = 0; i < n; i++) l = (l << 8) | der[pos++]
    }
    return l
  }
  function readTlv(): { tag: number; start: number; end: number } {
    const tag = der[pos++]
    const len = readLen()
    const start = pos
    pos += len
    return { tag, start, end: start + len }
  }
  function bytesToBigInt(bytes: Uint8Array): bigint {
    let v = 0n
    for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i])
    return v
  }
  function readInt(): bigint {
    const tlv = readTlv()
    if (tlv.tag !== 0x02) throw new Error('RSA key: expected INTEGER')
    return bytesToBigInt(der.subarray(tlv.start, tlv.end))
  }

  const outer = readTlv() // SPKI SEQUENCE
  if (outer.tag !== 0x30) throw new Error('RSA key: invalid SPKI')
  pos = outer.start
  const algSeq = readTlv() // AlgorithmIdentifier
  if (algSeq.tag !== 0x30) throw new Error('RSA key: invalid algorithm')
  pos = algSeq.end
  const bitString = readTlv()
  if (bitString.tag !== 0x03) throw new Error('RSA key: expected BIT STRING')
  pos = bitString.start + 1 // 跳过 unused bits
  const rsaSeq = readTlv()
  if (rsaSeq.tag !== 0x30) throw new Error('RSA key: expected RSAPublicKey')
  pos = rsaSeq.start
  const n = readInt()
  const e = readInt()
  return { n, e }
}

function bigIntToBytes(v: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size)
  let i = size - 1
  while (v > 0n && i >= 0) {
    out[i--] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

export function rsaEncrypt(buffer: string | Uint8Array, key: string | { key: string; padding?: number }): Buffer {
  const keyPem = typeof key === 'string' ? key : key.key
  const padding = typeof key === 'string' ? constants.RSA_PKCS1_PADDING : (key.padding == null ? constants.RSA_PKCS1_PADDING : key.padding)
  const data = bufferToBytes(buffer)
  if (padding === constants.RSA_NO_PADDING) {
    const { n, e } = parseRsaPublicKey(keyPem)
    const size = Math.ceil(n.toString(16).length / 2)
    const m = (() => {
      let v = 0n
      for (let i = 0; i < data.length; i++) v = (v << 8n) | BigInt(data[i])
      return v
    })()
    let c = 1n
    let base = m % n
    let exp = e
    while (exp > 0n) {
      if (exp & 1n) c = (c * base) % n
      base = (base * base) % n
      exp >>= 1n
    }
    return new Buffer(bigIntToBytes(c, size))
  }
  return new Buffer(hexDecode(__go_crypto_rsa_encrypt(hexEncode(data), keyPem)))
}

export function publicEncrypt(key: string | { key: string; padding?: number }, buffer: string | Uint8Array): Buffer {
  return rsaEncrypt(buffer, key)
}

export function randomBytes(size: number): Buffer {
  return new Buffer(hexDecode(__go_crypto_random_bytes(size)))
}

// ===== zlib（宿主原生桥接） =====

export function inflate(buffer: string | Uint8Array): Buffer {
  return new Buffer(hexDecode(__go_zlib_inflate(hexEncode(bufferToBytes(buffer)))))
}

export function deflate(buffer: string | Uint8Array): Buffer {
  return new Buffer(hexDecode(__go_zlib_deflate(hexEncode(bufferToBytes(buffer)))))
}

export function inflateRaw(buffer: string | Uint8Array): Buffer {
  return new Buffer(hexDecode(__go_raw_inflate(hexEncode(bufferToBytes(buffer)))))
}
