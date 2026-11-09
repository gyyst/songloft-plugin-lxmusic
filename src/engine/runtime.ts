/**
 * 单个音源脚本的宿主封装。
 *
 * 生命周期：
 *   create env(initCode=LX_PRELUDE_JS)
 *     → execute 注入 currentScriptInfo
 *     → executeWait(script, ['inited']) 获取 sources
 *     → 后续每次取链接 executeWait('lx._dispatch(...)', ['dispatchResult','dispatchError'])
 *     → destroy
 */
import { LX_PRELUDE_JS } from './lx_prelude'
import {
  errorMessage,
  QUALITY_ORDER,
  type ResolvedSourceUrl,
  type RuntimeSourceMeta,
  type RuntimeStats,
  type RuntimeStatus,
  type SourceCapabilities,
  type SourceCapability,
} from './types'

let requestSeq = 0

/** 子 VM 的 env 名只允许安全字符；非 ASCII 一律转成 u<hex>。 */
export function safeEnvName(id: string): string {
  let out = ''
  for (const ch of String(id || 'source')) {
    const code = ch.codePointAt(0) || 0
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || ch === '_' || ch === '-') {
      out += ch
    } else if (code > 0x7f) {
      out += 'u' + code.toString(16)
    } else {
      out += '_'
    }
  }
  return 'src_' + (out || 'source')
}

function parseJson(value: string | undefined | null): any {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** 兼容 sources 为对象或数组两种写法。 */
function normalizeCapabilities(raw: any): SourceCapabilities {
  const out: SourceCapabilities = {}
  if (!raw) return out
  const entries: Array<[string, any]> = Array.isArray(raw)
    ? raw.map((item: any) => [String(item?.source || item?.id || item?.platform || ''), item] as [string, any])
    : Object.keys(raw).map((key) => [key, raw[key]] as [string, any])
  for (const [rawKey, value] of entries) {
    const platform = String(rawKey || '').trim().toLowerCase()
    if (!platform || !value || typeof value !== 'object') continue
    const actions = Array.isArray(value.actions)
      ? value.actions.map((a: any) => String(a).trim()).filter(Boolean)
      : ['musicUrl']
    const qualitys = Array.isArray(value.qualitys)
      ? value.qualitys.map((q: any) => String(q).trim()).filter(Boolean)
      : ['128k', '320k', 'flac', 'flac24bit']
    out[platform] = {
      type: String(value.type || 'music'),
      actions: actions.length ? actions : ['musicUrl'],
      qualitys,
    }
  }
  return out
}

export class SourceRuntime {
  readonly meta: RuntimeSourceMeta
  readonly envName: string
  capabilities: SourceCapabilities = {}
  status: RuntimeStatus = 'idle'
  error = ''
  stats: RuntimeStats = {
    totalCalls: 0,
    successCalls: 0,
    failedCalls: 0,
    lastSuccessAt: 0,
    lastErrorAt: 0,
    lastError: '',
  }

  private created = false
  private loadPromise: Promise<void> | null = null

  constructor(meta: RuntimeSourceMeta) {
    this.meta = meta
    this.envName = safeEnvName(meta.id)
  }

  get id(): string {
    return this.meta.id
  }

  get name(): string {
    return this.meta.name
  }

  /** env 是否已成功创建并完成初始化。 */
  get ready(): boolean {
    return this.status === 'ready'
  }

  supportsAction(platform: string, action = 'musicUrl'): boolean {
    const cap = this.capabilities[platform]
    if (!cap) return false
    return !cap.actions.length || cap.actions.includes(action)
  }

  supportsQuality(platform: string, quality: string): boolean {
    const cap = this.capabilities[platform]
    if (!cap) return false
    return cap.qualitys.length === 0 || cap.qualitys.includes(quality)
  }

  /** 选择实际请求的音质：优先请求值，其次按高→低降级。 */
  pickQuality(platform: string, desired: string): string {
    const cap = this.capabilities[platform]
    if (!cap) return desired
    if (!cap.qualitys.length || cap.qualitys.includes(desired)) return desired
    for (const q of QUALITY_ORDER) {
      if (cap.qualitys.includes(q)) return q
    }
    return cap.qualitys[0] || desired
  }

  /** 并发调用时共享同一次加载。 */
  load(): Promise<void> {
    if (this.status === 'ready') return Promise.resolve()
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.doLoad().finally(() => {
      this.loadPromise = null
    })
    return this.loadPromise
  }

  /** 等待正在进行的加载（如果有）。 */
  async waitLoad(): Promise<void> {
    if (this.loadPromise) {
      try {
        await this.loadPromise
      } catch {
        // 调用方只关心“加载已结束”
      }
    }
  }

  private async doLoad(): Promise<void> {
    this.status = 'loading'
    this.error = ''
    this.capabilities = {}
    try {
      // 防御：同名 env 可能因上次异常退出而残留。
      if (this.created) {
        try {
          await songloft.jsenv.destroy(this.envName)
        } catch {
          // ignore
        }
        this.created = false
      }
      await songloft.jsenv.create(this.envName, LX_PRELUDE_JS)
      this.created = true

      const scriptInfo = {
        name: this.meta.name,
        description: this.meta.description,
        version: this.meta.version,
        author: this.meta.author,
        homepage: this.meta.homepage,
        rawScript: this.meta.script,
      }
      const injected = JSON.stringify(scriptInfo)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
      const injectResult = await songloft.jsenv.execute(
        this.envName,
        'globalThis.lx.currentScriptInfo = ' + injected + ';',
        15000,
      )
      if (injectResult.error) throw new Error('注入脚本信息失败: ' + injectResult.error)

      const initResult = await songloft.jsenv.executeWait(this.envName, this.meta.script, 30000, ['inited'])
      if (initResult.error) throw new Error(initResult.error)
      const initEvent = initResult.events.find((e) => e.name === 'inited')
      if (!initEvent) throw new Error('音源脚本未发送 inited 事件（不是有效的洛雪音源，或初始化超时）')
      const initData = parseJson(initEvent.data)
      if (initData && initData.status === false) {
        throw new Error(String(initData.message || initData.msg || '音源初始化失败'))
      }
      const capabilities = normalizeCapabilities(initData?.sources || initData?.sourceInfo?.sources)
      if (!Object.keys(capabilities).length) throw new Error('音源未声明任何可用平台')
      this.capabilities = capabilities
      this.status = 'ready'
    } catch (err) {
      this.status = 'error'
      this.error = errorMessage(err)
      await this.destroyEnv()
      throw err
    }
  }

  /** 构造一次 executeParallel 调用（不修改统计）。 */
  buildDispatchCall(platform: string, quality: string, musicInfo: any, reqId?: string): {
    name: string
    code: string
    timeoutMs: number
    waitEvents: string[]
  } {
    const actualQuality = this.pickQuality(platform, quality)
    const id = reqId || 'r' + (++requestSeq).toString(36) + '_' + Date.now().toString(36)
    const payload = JSON.stringify({
      source: platform,
      action: 'musicUrl',
      info: { musicInfo, type: actualQuality },
    })
    return {
      name: this.envName,
      code: 'lx._dispatch(' + JSON.stringify(id) + ', "request", ' + JSON.stringify(payload) + ');',
      timeoutMs: 22000,
      waitEvents: ['dispatchResult', 'dispatchError'],
    }
  }

  /** 解析 executeParallel 返回的胜出结果（不修改统计）。 */
  parseDispatchResult(
    result: { result: string; events: Array<{ name: string; data: string }>; error?: string },
    platform: string,
    requestedQuality: string,
  ): ResolvedSourceUrl {
    if (result.error) throw new Error(result.error)
    const event = result.events.find((e) => e.name === 'dispatchResult' || e.name === 'dispatchError')
    if (!event) throw new Error('音源没有返回结果（可能执行超时）')
    const envelope = parseJson(event.data)
    if (event.name === 'dispatchError') {
      throw new Error(String(envelope?.data?.error || envelope?.error || '音源解析失败'))
    }
    const parsed = this.extractUrl(envelope?.data)
    if (!parsed.url) throw new Error('音源返回了无效的播放地址')
    return {
      url: parsed.url,
      headers: parsed.headers,
      quality: this.pickQuality(platform, requestedQuality),
      sourceId: this.id,
      sourceName: this.name,
    }
  }

  /** 单独使用一个 runtime 取链接（调试/直连用）。 */
  async getMusicUrl(platform: string, quality: string, musicInfo: any): Promise<ResolvedSourceUrl> {
    if (this.status !== 'ready') throw new Error(`音源「${this.name}」未就绪`)
    if (!this.supportsAction(platform, 'musicUrl')) throw new Error(`音源「${this.name}」不支持平台 ${platform}`)
    const call = this.buildDispatchCall(platform, quality, musicInfo)
    this.stats.totalCalls++
    try {
      const result = await songloft.jsenv.executeWait(this.envName, call.code, call.timeoutMs, call.waitEvents)
      const resolved = this.parseDispatchResult(result, platform, quality)
      this.stats.successCalls++
      this.stats.lastSuccessAt = Date.now()
      return resolved
    } catch (err) {
      this.recordFailure(errorMessage(err))
      throw err
    }
  }

  private extractUrl(raw: any): { url: string; headers?: Record<string, string> } {
    let value = raw
    let headers: Record<string, string> | undefined
    if (typeof value === 'string') {
      return { url: this.cleanUrl(value) }
    }
    if (!value || typeof value !== 'object') return { url: '' }
    if (value.headers && typeof value.headers === 'object') {
      headers = {}
      for (const key of Object.keys(value.headers)) {
        const v = value.headers[key]
        if (v !== undefined && v !== null) headers[key] = String(v)
      }
    }
    let url = value.url || value.Url || value.URL
    if (!url && typeof value.data === 'string') url = value.data
    if (!url && value.data && typeof value.data === 'object') {
      url = value.data.url || value.data.Url || value.data.URL
      if (!headers && value.data.headers && typeof value.data.headers === 'object') {
        headers = {}
        for (const key of Object.keys(value.data.headers)) {
          const v = value.data.headers[key]
          if (v !== undefined && v !== null) headers[key] = String(v)
        }
      }
    }
    if (!url && typeof value.result === 'string') url = value.result
    return { url: this.cleanUrl(url), headers: headers && Object.keys(headers).length ? headers : undefined }
  }

  private cleanUrl(value: any): string {
    const url = String(value == null ? '' : value).trim()
    if (!/^https?:\/\//i.test(url)) return ''
    if (url.length > 8192) return ''
    return url
  }

  private recordFailure(message: string): void {
    this.stats.failedCalls++
    this.stats.lastError = message
    this.stats.lastErrorAt = Date.now()
  }

  private async destroyEnv(): Promise<void> {
    if (!this.created) return
    this.created = false
    try {
      await songloft.jsenv.destroy(this.envName)
    } catch {
      // best-effort
    }
  }

  /** 停用/删除时释放子 VM。 */
  async unload(): Promise<void> {
    await this.destroyEnv()
    this.capabilities = {}
    this.error = ''
    this.status = 'idle'
  }

  /** 彻底销毁（失败路径）。 */
  async destroy(): Promise<void> {
    await this.destroyEnv()
    this.capabilities = {}
    this.status = 'idle'
  }

  toPlatformList(): Array<{ platform: string; type: string; actions: string[]; qualitys: string[] }> {
    return Object.keys(this.capabilities).map((platform) => {
      const cap: SourceCapability = this.capabilities[platform]
      return {
        platform,
        type: cap.type,
        actions: cap.actions.slice(),
        qualitys: cap.qualitys.slice(),
      }
    })
  }
}
