/**
 * needle → 沙箱 fetch 的适配层。
 *
 * 保持 lxserver `httpFetch(url, options)` 的签名与返回结构：
 *   const { promise, cancelHttp } = httpFetch(url, { method, headers, body, form, timeout })
 *   promise -> { statusCode, headers, body, raw }
 * `body` 会自动尝试 JSON.parse，`raw` 是原始字节（酷我歌词解密依赖它）。
 */
import { Buffer, base64Encode, hexEncode } from '../utils/buffer'
import { deflate } from './crypto-shim'

export interface HttpFetchResponse {
  statusCode: number
  statusMessage?: string
  headers: Record<string, any>
  body: any
  raw: Buffer
}

export interface HttpFetchOptions {
  method?: string
  headers?: Record<string, any>
  body?: any
  form?: Record<string, any> | string
  formData?: Record<string, any> | Array<{ name: string; value: any }>
  timeout?: number
  [key: string]: any
}

export interface HttpFetchResult {
  promise: Promise<HttpFetchResponse>
  cancelHttp: () => void
}

const defaultHeaders: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

// lxserver options.js 的 bHh 头混淆逻辑（酷狗部分接口依赖）
const bHh = '624868746c'
const headerRegx = /(?:\d\w)+/g

function urlEncode(obj: Record<string, any>): string {
  return Object.keys(obj)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k] == null ? '' : String(obj[k]))}`)
    .join('&')
}

function buildFormData(formData: Record<string, any> | Array<{ name: string; value: any }>): { body: string; contentType: string } {
  const boundary = '----SongloftFormBoundary' + Math.random().toString(16).slice(2)
  const entries: Array<[string, any]> = Array.isArray(formData)
    ? formData.map((item) => [item.name, item.value])
    : Object.keys(formData).map((k) => [k, (formData as Record<string, any>)[k]])
  let body = ''
  for (const [name, value] of entries) {
    body += `--${boundary}\r\n`
    body += `Content-Disposition: form-data; name="${name}"\r\n\r\n`
    body += `${value == null ? '' : String(value)}\r\n`
  }
  body += `--${boundary}--\r\n`
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

/** zlib deflate → 去掉 2 字节头与 4 字节 Adler32，得到 raw deflate。 */
function deflateRaw(data: Uint8Array): Buffer {
  const z = deflate(data)
  return z.length > 6 ? z.subarray(2, z.length - 4) : z
}

function applyFakeHeader(headers: Record<string, any>, url: string): void {
  if (!headers[bHh]) return
  const path = url.replace(/^https?:\/\/[\w.:]+\//, '/')
  let s = Buffer.from(bHh, 'hex').toString()
  s = s.replace(s.substr(-1), '')
  s = Buffer.from(s, 'base64').toString()
  const v1 = '2050201'
  const v2 = '10'
  const v = v1.split('-')[0].split('.').map((n) => (n.length < 3 ? n.padStart(3, '0') : n)).join('')
  const payload = JSON.stringify(`${path}${v}`.match(headerRegx), null, 1).concat(v)
  headers[s] = `${deflateRaw(Buffer.from(payload)).toString('hex')}&${parseInt(v)}${v2}`
  delete headers[bHh]
}

function normalizeHeaders(raw: Record<string, any>): Record<string, any> {
  const headers: Record<string, any> = {}
  for (const key of Object.keys(raw || {})) headers[key] = raw[key]
  // 平台代码按 node 语义读取 headers['set-cookie'][0]
  if (headers['set-cookie'] && !Array.isArray(headers['set-cookie'])) {
    headers['set-cookie'] = [String(headers['set-cookie'])]
  }
  if (headers['Set-Cookie'] && !headers['set-cookie']) {
    headers['set-cookie'] = Array.isArray(headers['Set-Cookie']) ? headers['Set-Cookie'] : [String(headers['Set-Cookie'])]
  }
  return headers
}

export function httpFetch(url: string, options: HttpFetchOptions = {}): HttpFetchResult {
  let cancelled = false
  const method = String(options.method || 'get').toUpperCase()
  const headers: Record<string, any> = Object.assign({}, defaultHeaders, options.headers || {})
  applyFakeHeader(headers, url)

  let body: string | Uint8Array | undefined
  if (options.form) {
    body = typeof options.form === 'string' ? options.form : urlEncode(options.form)
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  } else if (options.formData) {
    const fd = buildFormData(options.formData)
    body = fd.body
    headers['Content-Type'] = fd.contentType
  } else if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === 'string' || options.body instanceof Uint8Array) {
      body = options.body as any
    } else {
      body = JSON.stringify(options.body)
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json'
    }
  }

  const timeout = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : 15000

  const promise = (async (): Promise<HttpFetchResponse> => {
    const init: Record<string, any> = { method, headers }
    if (body !== undefined) init.body = body
    const resp = await fetch(url, init)
    const ab = await resp.arrayBuffer()
    const raw = new Buffer(ab)
    const text = raw.toString('utf8')
    let parsed: any = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // 保持原始文本（歌词、HTML 等）
    }
    if (cancelled) {
      // 取消后仍返回结果，避免挂起的 await；调用方通常已丢弃旧请求引用。
    }
    return {
      statusCode: resp.status,
      statusMessage: resp.statusText,
      headers: normalizeHeaders(resp.headers as unknown as Record<string, any>),
      body: parsed,
      raw,
    }
  })()

  const guarded = new Promise<HttpFetchResponse>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request Timeout')), timeout)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })

  return {
    promise: guarded,
    cancelHttp: () => { cancelled = true },
  }
}

/** 兼容 lxserver 的 httpGet/httpPost 辅助。 */
export function httpGet(url: string, options: HttpFetchOptions = {}): Promise<HttpFetchResponse> {
  return httpFetch(url, { ...options, method: 'get' }).promise
}

export function httpPost(url: string, data: any, options: HttpFetchOptions = {}): Promise<HttpFetchResponse> {
  return httpFetch(url, { ...options, method: 'post', body: data }).promise
}

export { base64Encode, hexEncode }
