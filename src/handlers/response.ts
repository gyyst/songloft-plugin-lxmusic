/** 插件内部 UI 统一响应格式：{code, msg, data, warning?}。 */
import { jsonResponse } from '@songloft/plugin-sdk'

export interface ApiPayload<T = any> {
  code: number
  msg: string
  data: T | null
  warning?: string
}

export function ok<T = any>(data: T, extra: Record<string, unknown> = {}) {
  return jsonResponse({ code: 0, msg: 'success', data, ...extra } as ApiPayload<T>)
}

export function okWithWarning<T = any>(data: T, warning: string, extra: Record<string, unknown> = {}) {
  return jsonResponse({ code: 0, msg: 'success', data, warning, ...extra } as ApiPayload<T>)
}

export function fail(message: string, statusCode = 400, data: any = null) {
  return jsonResponse({ code: statusCode, msg: message, data } as ApiPayload, statusCode)
}

/** 主程序契约端点（/api/search、/api/music/url）的错误响应。 */
export function contractError(message: string, statusCode = 500) {
  return jsonResponse({ error: message }, statusCode)
}
