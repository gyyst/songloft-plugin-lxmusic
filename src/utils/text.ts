/** 文本/字节转换工具（插件主环境）。 */
import { Buffer, bufferToBytes, hexEncode, hexDecode } from './buffer'

/** latin1 字符串（每字符一字节）→ Uint8Array。 */
export function latin1ToBytes(input: string): Uint8Array {
  const out = new Uint8Array(input.length)
  for (let i = 0; i < input.length; i++) out[i] = input.charCodeAt(i) & 0xff
  return out
}

/** Uint8Array → latin1 字符串。 */
export function bytesToLatin1(bytes: Uint8Array): string {
  let out = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + chunk) as number[])
  }
  return out
}

/** 按 UTF-8 解码；出现替换字符时回退 GB18030（音源脚本常见 GBK 编码）。 */
export function decodeBytesBestEffort(bytes: Uint8Array): string {
  const utf8 = new Buffer(bytes).toString('utf8')
  if (utf8.indexOf('�') === -1) return utf8
  try {
    const gbk = new Buffer(bytes).toString('gb18030')
    if (gbk && gbk.indexOf('�') === -1) return gbk
    return gbk || utf8
  } catch {
    return utf8
  }
}

/** 把 HTTP body（可能是 latin1 字符串或 Uint8Array）统一成字节。 */
export function bodyToBytes(body: unknown): Uint8Array {
  if (body == null) return new Uint8Array(0)
  if (typeof body === 'string') return latin1ToBytes(body)
  if (body instanceof Uint8Array) return bufferToBytes(body)
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return new Uint8Array(body)
  return latin1ToBytes(String(body))
}

/** 把 JSON 请求体解析成对象。 */
export function parseJsonBody(body: unknown): any {
  if (body == null || body === '') return {}
  if (typeof body === 'object' && !(body instanceof Uint8Array)) return body
  let text: string
  if (typeof body === 'string') text = body
  else text = decodeBytesBestEffort(bodyToBytes(body))
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** 从 Content-Type 中取 boundary。 */
export function multipartBoundary(contentType: string): string {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  return (match?.[1] || match?.[2] || '').trim()
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  if (!needle.length) return from
  const first = needle[0]
  const limit = haystack.length - needle.length
  for (let i = Math.max(0, from); i <= limit; i++) {
    if (haystack[i] !== first) continue
    let ok = true
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

export interface MultipartPart {
  name: string
  fileName?: string
  contentType?: string
  data: Uint8Array
}

/** 解析 multipart/form-data。body 需是字节（latin1 字符串按字节解释）。 */
export function parseMultipart(body: Uint8Array, boundary: string): MultipartPart[] {
  if (!boundary) return []
  const delimiter = latin1ToBytes('--' + boundary)
  const headerEndToken = latin1ToBytes('\r\n\r\n')
  const parts: MultipartPart[] = []
  let pos = 0
  for (;;) {
    const start = indexOfBytes(body, delimiter, pos)
    if (start < 0) break
    let cursor = start + delimiter.length
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break // "--" 结束
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2
    const headerEnd = indexOfBytes(body, headerEndToken, cursor)
    if (headerEnd < 0) break
    const headerText = decodeBytesBestEffort(body.subarray(cursor, headerEnd))
    const contentStart = headerEnd + 4
    const nextDelimiter = indexOfBytes(body, delimiter, contentStart)
    if (nextDelimiter < 0) break
    let contentEnd = nextDelimiter
    if (contentEnd >= 2 && body[contentEnd - 2] === 0x0d && body[contentEnd - 1] === 0x0a) contentEnd -= 2
    const headers: Record<string, string> = {}
    for (const line of headerText.split('\r\n')) {
      const idx = line.indexOf(':')
      if (idx <= 0) continue
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
    }
    const disposition = headers['content-disposition'] || ''
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1] || ''
    let fileName = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1]
    const encodedName = /(?:^|;)\s*filename\*=([^;]+)/i.exec(disposition)?.[1]
    if (encodedName) {
      const m = /^[^']*'[^']*'(.*)$/.exec(encodedName.trim())
      if (m) {
        try {
          fileName = decodeURIComponent(m[1])
        } catch {
          fileName = m[1]
        }
      }
    }
    parts.push({
      name,
      fileName,
      contentType: headers['content-type'],
      data: body.subarray(contentStart, contentEnd),
    })
    pos = nextDelimiter + delimiter.length
  }
  return parts
}

/** ZIP 魔数检测。 */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
}

export { hexEncode, hexDecode }
