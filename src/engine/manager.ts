/**
 * RuntimeManager：管理多个 SourceRuntime，维护平台 → runtime[] 反向索引。
 *
 * 取播放链接时对支持该平台的多源并行竞速（executeParallel，最大并发 3），
 * 首个成功者胜出；运行统计按 successCalls / totalCalls 排序。
 */
import { SourceRuntime } from './runtime'
import { errorMessage, QUALITY_ORDER, type ResolvedSourceUrl } from './types'

type PlatformLoader = (platform: string) => Promise<void>

export class RuntimeManager {
  private runtimes = new Map<string, SourceRuntime>()
  private byPlatform = new Map<string, SourceRuntime[]>()
  private platformLoader: PlatformLoader | null = null

  setPlatformLoader(loader: PlatformLoader): void {
    this.platformLoader = loader
  }

  register(runtime: SourceRuntime): void {
    this.unregister(runtime.id)
    this.runtimes.set(runtime.id, runtime)
    this.rebuildIndex()
  }

  unregister(id: string): void {
    if (!this.runtimes.has(id)) return
    this.runtimes.delete(id)
    this.rebuildIndex()
  }

  get(id: string): SourceRuntime | null {
    return this.runtimes.get(id) || null
  }

  list(): SourceRuntime[] {
    return Array.from(this.runtimes.values())
  }

  private rebuildIndex(): void {
    const index = new Map<string, SourceRuntime[]>()
    for (const runtime of this.runtimes.values()) {
      for (const platform of Object.keys(runtime.capabilities)) {
        const list = index.get(platform) || []
        list.push(runtime)
        index.set(platform, list)
      }
    }
    this.byPlatform = index
  }

  /** 重新构建平台索引（runtime 加载完成/能力变化后调用）。 */
  refresh(): void {
    this.rebuildIndex()
  }

  /** 当前有 ready 音源覆盖的平台。 */
  readyPlatforms(): string[] {
    const set = new Set<string>()
    for (const runtime of this.runtimes.values()) {
      if (runtime.status !== 'ready') continue
      for (const platform of Object.keys(runtime.capabilities)) set.add(platform)
    }
    return Array.from(set)
  }

  hasReadySource(platform: string): boolean {
    return this.readyRuntimes(platform).length > 0
  }

  private readyRuntimes(platform: string): SourceRuntime[] {
    const list = (this.byPlatform.get(platform) || []).filter(
      (runtime) => runtime.status === 'ready' && runtime.supportsAction(platform, 'musicUrl'),
    )
    return sortByStats(list)
  }

  /** 供 fallback 选择音质：返回该平台某个 ready 源能提供的音质。 */
  pickPlatformQuality(platform: string, desired: string): string {
    const list = this.readyRuntimes(platform)
    if (!list.length) return desired
    for (const runtime of list) {
      if (runtime.supportsQuality(platform, desired)) return desired
    }
    for (const quality of QUALITY_ORDER) {
      for (const runtime of list) {
        if (runtime.supportsQuality(platform, quality)) return quality
      }
    }
    return desired
  }

  /**
   * 解析播放链接。若当前没有 ready 源，会先请求 SourceManager 懒加载。
   */
  async getMusicUrl(platform: string, quality: string, musicInfo: any): Promise<ResolvedSourceUrl> {
    let candidates = this.readyRuntimes(platform)
    if (!candidates.length && this.platformLoader) {
      try {
        await this.platformLoader(platform)
      } catch {
        // 懒加载失败时继续走统一报错
      }
      candidates = this.readyRuntimes(platform)
    }
    if (!candidates.length) {
      throw new Error(`没有可用的音源支持平台 ${platform}（请先在音源管理中导入并启用洛雪音源脚本）`)
    }

    const round = ++probeSeq
    const calls = candidates.map((runtime, index) => {
      const actualQuality = runtime.pickQuality(platform, quality)
      const reqId = 'probe_' + round.toString(36) + '_' + index
      // 复用 runtime 的请求构造逻辑，避免 Manager 直接拼 lx 内部协议。
      return runtime.buildDispatchCall(platform, actualQuality, musicInfo, reqId)
    })

    const result = await songloft.jsenv.executeParallel(calls, 3)
    if (result.successIndex < 0 || !result.result) {
      const messages = (result.errors || []).filter(Boolean)
      const detail = messages.length ? messages[0] : '音源未返回结果'
      for (const runtime of candidates) {
        runtime.stats.totalCalls++
        runtime.stats.failedCalls++
        runtime.stats.lastError = detail
        runtime.stats.lastErrorAt = Date.now()
      }
      throw new Error('播放链接解析失败: ' + detail)
    }

    // 记录本轮统计：total 全部计入，错误项计入失败。
    for (let i = 0; i < candidates.length; i++) {
      const runtime = candidates[i]
      runtime.stats.totalCalls++
      if (i !== result.successIndex && result.errors && result.errors[i]) {
        runtime.stats.failedCalls++
        runtime.stats.lastError = result.errors[i]
        runtime.stats.lastErrorAt = Date.now()
      }
    }

    const winner = candidates[result.successIndex]
    if (!winner) throw new Error('播放链接解析失败: 未找到胜出的音源')
    try {
      const resolved = winner.parseDispatchResult(result.result, platform, quality)
      winner.stats.successCalls++
      winner.stats.lastSuccessAt = Date.now()
      return resolved
    } catch (err) {
      winner.stats.failedCalls++
      winner.stats.lastError = errorMessage(err)
      winner.stats.lastErrorAt = Date.now()
      throw err
    }
  }
}

let probeSeq = 0

function sortByStats(list: SourceRuntime[]): SourceRuntime[] {
  return list.slice().sort((a, b) => {
    const ra = a.stats.totalCalls ? a.stats.successCalls / a.stats.totalCalls : 0.5
    const rb = b.stats.totalCalls ? b.stats.successCalls / b.stats.totalCalls : 0.5
    if (rb !== ra) return rb - ra
    if (b.stats.lastSuccessAt !== a.stats.lastSuccessAt) return b.stats.lastSuccessAt - a.stats.lastSuccessAt
    return a.name.localeCompare(b.name)
  })
}
