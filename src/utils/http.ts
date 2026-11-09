/** 宿主 OpenAPI 调用封装。 */

export interface HostRequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
}

/** 调用宿主的 /api/v1 接口，自动带上插件 JWT。 */
export async function callHostAPI(path: string, options: HostRequestOptions = {}): Promise<any> {
  const base = (await songloft.plugin.getHostUrl()).replace(/\/+$/, '')
  const token = await songloft.plugin.getToken()
  const url = base + (path.startsWith('/') ? path : '/' + path)
  const headers: Record<string, string> = {
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
    ...(options.headers || {}),
  }
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method: options.method || 'GET',
    headers,
  }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)

  const ms = options.timeoutMs || 30000
  let timer: number | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`宿主接口 ${path} 超时（${ms}ms）`)), ms) as unknown as number
  })
  let response: Response
  try {
    response = await Promise.race([fetch(url, init), timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
  const text = await response.text()
  let data: any = text
  try {
    data = JSON.parse(text)
  } catch {
    // 保留纯文本
  }
  if (!response.ok) {
    const message = typeof data === 'string' ? data : data?.error || data?.message || JSON.stringify(data)
    throw new Error(`宿主接口 ${path} 失败（${response.status}）：${message}`)
  }
  return data
}

/** 获取当前宿主的插件自身 URL 前缀（用于生成歌词等回调地址）。 */
export async function pluginBaseUrl(entryPath: string): Promise<string> {
  const base = (await songloft.plugin.getHostUrl()).replace(/\/+$/, '')
  return `${base}/api/v1/jsplugin/${entryPath}`
}
