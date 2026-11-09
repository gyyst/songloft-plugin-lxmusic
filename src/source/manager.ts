/**
 * SourceManager：音源脚本的导入、删除、启停、持久化与加载调度。
 *
 * 设计要点：
 * - 构造器只建立空状态，必须 await init()。
 * - 加载音源 = 在独立子 VM 中执行脚本并等待 inited 事件。
 * - ZIP 批量导入先以 enabled=false 落库并立即返回，后台 setTimeout 链
 *   逐个加载、加载成功后启用，间隔 1000ms，避免一次性占满 QuickJS。
 */
import { RuntimeManager, SourceRuntime } from '../engine'
import type { RuntimeSourceMeta } from '../engine/types'
import { errorMessage } from '../engine/types'
import { nameFromFileName, parseScriptMeta, slugifyName, uniqueId } from './parser'
import { SourceStorage } from './storage'
import type { ImportResult, SourceCandidate, SourceListSnapshot, SourceMeta, SourceSnapshot } from './types'

const MAX_SCRIPT_BYTES = 8 * 1024 * 1024
const QUEUE_INTERVAL_MS = 1000

interface SourceEntry {
  meta: SourceMeta
  script: string
  runtime: SourceRuntime
}

interface QueueItem {
  id: string
  /** 加载成功后是否自动启用。 */
  enable: boolean
}

function toRuntimeMeta(meta: SourceMeta, script: string): RuntimeSourceMeta {
  return {
    id: meta.id,
    name: meta.name,
    version: meta.version,
    description: meta.description,
    author: meta.author,
    homepage: meta.homepage,
    script,
  }
}

function normalizeScript(script: string): string {
  let text = String(script == null ? '' : script)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

function scriptSize(script: string): number {
  try {
    return new TextEncoder().encode(script).length
  } catch {
    return script.length
  }
}

export class SourceManager {
  private readonly storage = new SourceStorage()
  private readonly entries = new Map<string, SourceEntry>()
  private initialized = false
  private queue: QueueItem[] = []
  private queueRunning = false
  private currentId: string | null = null
  private queueTimer: number | null = null
  private persistChain: Promise<void> = Promise.resolve()
  private platformLoads = new Map<string, Promise<void>>()

  constructor(private readonly runtimeManager: RuntimeManager) {}

  /** 读取索引、恢复 runtime 注册，并异步加载已启用音源。 */
  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    let list: SourceMeta[] = []
    try {
      list = await this.storage.loadIndex()
    } catch (err) {
      songloft.log.error('读取音源索引失败: ' + errorMessage(err))
      return
    }

    const valid: SourceMeta[] = []
    for (const meta of list) {
      let script = ''
      try {
        script = await this.storage.loadScript(meta.id)
      } catch {
        script = ''
      }
      if (!script) {
        songloft.log.warn(`音源「${meta.name}」的脚本内容缺失，已从索引移除`)
        continue
      }
      const entry: SourceEntry = {
        meta,
        script,
        runtime: new SourceRuntime(toRuntimeMeta(meta, script)),
      }
      this.entries.set(meta.id, entry)
      this.runtimeManager.register(entry.runtime)
      valid.push(meta)
    }

    if (valid.length !== list.length) {
      await this.storage.saveIndex(valid).catch(() => undefined)
    }

    this.runtimeManager.setPlatformLoader((platform) => this.loadPendingForPlatform(platform))

    const enabledIds = valid.filter((meta) => meta.enabled).map((meta) => meta.id)
    if (enabledIds.length) this.enqueue(enabledIds, false)

    songloft.log.info(`音源管理器已初始化：${valid.length} 个音源，${enabledIds.length} 个待加载`)
  }

  private persistIndex(): Promise<void> {
    const list = Array.from(this.entries.values()).map((entry) => ({ ...entry.meta }))
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.storage.saveIndex(list))
      .catch((err) => {
        songloft.log.error('保存音源索引失败: ' + errorMessage(err))
      })
    return this.persistChain
  }

  private enqueue(ids: string[], enable: boolean): void {
    const exists = new Set(this.queue.map((item) => item.id))
    for (const id of ids) {
      if (!this.entries.has(id) || exists.has(id)) continue
      this.queue.push({ id, enable })
      exists.add(id)
    }
    if (!this.queueRunning) {
      this.queueRunning = true
      this.queueTimer = setTimeout(() => {
        void this.runQueueStep()
      }, 100) as unknown as number
    }
  }

  private async runQueueStep(): Promise<void> {
    this.queueTimer = null
    const item = this.queue.shift()
    if (!item) {
      this.queueRunning = false
      this.currentId = null
      await this.persistIndex()
      return
    }
    this.currentId = item.id
    const entry = this.entries.get(item.id)
    if (entry) {
      const ok = await this.loadEntry(item.id)
      if (item.enable) {
        entry.meta.enabled = ok
        entry.meta.updatedAt = Date.now()
        await this.persistIndex()
      }
    }
    this.currentId = null
    if (!this.queue.length) {
      this.queueRunning = false
      await this.persistIndex()
      return
    }
    this.queueTimer = setTimeout(() => {
      void this.runQueueStep()
    }, QUEUE_INTERVAL_MS) as unknown as number
  }

  /** 加载单个音源；失败返回 false 并把错误留在 runtime.error。 */
  async loadEntry(id: string): Promise<boolean> {
    const entry = this.entries.get(id)
    if (!entry) return false
    if (entry.runtime.status === 'ready') return true
    try {
      await entry.runtime.load()
      entry.meta.platforms = entry.runtime.toPlatformList()
      entry.meta.updatedAt = Date.now()
      this.runtimeManager.refresh()
      await this.persistIndex()
      songloft.log.info(`音源「${entry.meta.name}」加载成功，平台: ${Object.keys(entry.runtime.capabilities).join(',') || '无'}`)
      return true
    } catch (err) {
      entry.meta.updatedAt = Date.now()
      await this.persistIndex()
      songloft.log.warn(`音源「${entry.meta.name}」加载失败: ${errorMessage(err)}`)
      return false
    }
  }

  /**
   * 导入单个脚本。同名音源会先删除旧版本。
   * 默认同步加载；加载失败时保留脚本但置为停用，并返回 warning。
   */
  async importScript(script: string, fileName: string, options: { enable?: boolean } = {}): Promise<ImportResult> {
    const text = normalizeScript(script)
    const size = scriptSize(text)
    if (!text.trim()) throw new Error('音源脚本内容为空')
    if (size > MAX_SCRIPT_BYTES) throw new Error(`音源脚本过大（${(size / 1024 / 1024).toFixed(1)}MB），上限 8MB`)

    const parsed = parseScriptMeta(text, nameFromFileName(fileName))
    const old = this.findByName(parsed.name)
    let used = new Set(this.entries.keys())
    if (old) {
      await this.removeEntry(old.meta.id, false)
      used = new Set(this.entries.keys())
    }
    const id = uniqueId(slugifyName(parsed.name), used)
    const now = Date.now()
    const meta: SourceMeta = {
      id,
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      author: parsed.author,
      homepage: parsed.homepage,
      enabled: options.enable !== false,
      createdAt: now,
      updatedAt: now,
      size,
      fileName: String(fileName || ''),
      platforms: [],
    }

    try {
      await this.storage.saveScript(id, text)
    } catch (err) {
      throw new Error('保存音源脚本失败: ' + errorMessage(err))
    }

    const runtime = new SourceRuntime(toRuntimeMeta(meta, text))
    const entry: SourceEntry = { meta, script: text, runtime }
    this.entries.set(id, entry)
    this.runtimeManager.register(runtime)
    await this.persistIndex()

    let warning: string | undefined
    if (meta.enabled) {
      const ok = await this.loadEntry(id)
      if (!ok) {
        meta.enabled = false
        meta.updatedAt = Date.now()
        warning = `音源已导入但加载失败，已自动停用：${runtime.error || '未知错误'}`
        await this.persistIndex()
      }
    }
    return { meta: { ...meta }, warning }
  }

  /**
   * 批量导入（通常来自 ZIP）：全部以 enabled=false 落库并立即返回，
   * 后台逐个加载并启用。
   */
  async importBatch(candidates: SourceCandidate[], options: { enable?: boolean } = {}): Promise<{
    imported: ImportResult[]
    warnings: string[]
  }> {
    const warnings: string[] = []
    const normalized: SourceCandidate[] = []
    const byName = new Map<string, SourceCandidate>()
    for (const candidate of candidates) {
      const text = normalizeScript(candidate.script)
      const size = scriptSize(text)
      if (!text.trim()) continue
      if (size > MAX_SCRIPT_BYTES) {
        warnings.push(`${candidate.fileName}: 脚本过大（${(size / 1024 / 1024).toFixed(1)}MB），已跳过`)
        continue
      }
      const parsed = parseScriptMeta(text, nameFromFileName(candidate.fileName))
      const item: SourceCandidate = { script: text, fileName: candidate.fileName || parsed.name + '.js' }
      // 同一批内同名脚本以最后一个为准。
      byName.set(parsed.name, item)
    }
    for (const item of byName.values()) normalized.push(item)

    if (!normalized.length) return { imported: [], warnings }

    const imported: ImportResult[] = []
    const enableAfterLoad: string[] = []
    const now = Date.now()

    for (const candidate of normalized) {
      const parsed = parseScriptMeta(candidate.script, nameFromFileName(candidate.fileName))
      const old = this.findByName(parsed.name)
      if (old) await this.removeEntry(old.meta.id, false)

      const used = new Set(this.entries.keys())
      const id = uniqueId(slugifyName(parsed.name), used)
      const meta: SourceMeta = {
        id,
        name: parsed.name,
        version: parsed.version,
        description: parsed.description,
        author: parsed.author,
        homepage: parsed.homepage,
        enabled: false,
        createdAt: now,
        updatedAt: now,
        size: scriptSize(candidate.script),
        fileName: candidate.fileName,
        platforms: [],
      }
      try {
        await this.storage.saveScript(id, candidate.script)
      } catch (err) {
        warnings.push(`${candidate.fileName}: 保存失败 ${errorMessage(err)}`)
        continue
      }
      const runtime = new SourceRuntime(toRuntimeMeta(meta, candidate.script))
      this.entries.set(id, { meta, script: candidate.script, runtime })
      this.runtimeManager.register(runtime)
      imported.push({ meta: { ...meta } })
      if (options.enable !== false) enableAfterLoad.push(id)
    }

    await this.persistIndex()
    if (enableAfterLoad.length) this.enqueue(enableAfterLoad, true)
    return { imported, warnings }
  }

  private async removeEntry(id: string, persist = true): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    this.queue = this.queue.filter((item) => item.id !== id)
    this.entries.delete(id)
    this.runtimeManager.unregister(id)
    try {
      await entry.runtime.unload()
    } catch {
      // ignore
    }
    try {
      await this.storage.deleteScript(id)
    } catch {
      // ignore
    }
    if (persist) await this.persistIndex()
  }

  async deleteSource(id: string): Promise<boolean> {
    if (!this.entries.has(id)) return false
    await this.removeEntry(id, true)
    return true
  }

  /** 启用/停用。启用会等待加载完成，失败则保持停用。 */
  async toggleSource(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, error: '音源不存在' }
    if (enabled) {
      if (entry.runtime.status !== 'ready') {
        const ok = await this.loadEntry(id)
        if (!ok) return { ok: false, error: entry.runtime.error || '音源加载失败' }
      }
      entry.meta.enabled = true
      entry.meta.updatedAt = Date.now()
      await this.persistIndex()
      return { ok: true }
    }
    entry.meta.enabled = false
    entry.meta.updatedAt = Date.now()
    // 取消尚未执行的批量加载，否则后台队列会在稍后把音源重新启用。
    this.queue = this.queue.filter((item) => item.id !== id)
    await entry.runtime.unload()
    this.runtimeManager.refresh()
    await this.persistIndex()
    return { ok: true }
  }

  /** 平台缺少 ready 音源时的懒加载入口（RuntimeManager 调用）。 */
  loadPendingForPlatform(platform: string): Promise<void> {
    const existing = this.platformLoads.get(platform)
    if (existing) return existing
    const task = this.doLoadPendingForPlatform(platform).finally(() => {
      this.platformLoads.delete(platform)
    })
    this.platformLoads.set(platform, task)
    return task
  }

  private async doLoadPendingForPlatform(platform: string): Promise<void> {
    const hasReady = (): boolean =>
      Array.from(this.entries.values()).some(
        (entry) => entry.runtime.status === 'ready' && entry.runtime.supportsAction(platform, 'musicUrl'),
      )
    if (hasReady()) return

    const enabledEntries = Array.from(this.entries.values()).filter((entry) => entry.meta.enabled)
    // 先等正在加载的音源结束。
    const loading = enabledEntries.filter((entry) => entry.runtime.status === 'loading')
    if (loading.length) {
      await Promise.all(loading.map((entry) => entry.runtime.waitLoad()))
      if (hasReady()) return
    }

    for (const entry of enabledEntries) {
      if (entry.runtime.status === 'ready') continue
      if (entry.runtime.status === 'loading') continue
      await this.loadEntry(entry.meta.id)
      if (hasReady()) return
    }
  }

  findByName(name: string): SourceEntry | null {
    const target = String(name || '').trim()
    for (const entry of this.entries.values()) {
      if (entry.meta.name === target) return entry
    }
    return null
  }

  getMeta(id: string): SourceMeta | null {
    const entry = this.entries.get(id)
    return entry ? { ...entry.meta } : null
  }

  /** 指定音源支持哪些平台（优先用持久化的能力，未加载也能返回）。 */
  platformsForSource(id: string): string[] {
    const entry = this.entries.get(id)
    if (!entry) return []
    if (entry.runtime.status === 'ready') return Object.keys(entry.runtime.capabilities)
    return entry.meta.platforms.map((p) => p.platform)
  }

  /** 解析 source_id：可以是平台 id、音源 id 或 all。 */
  resolvePlatforms(sourceId: string): string[] {
    const value = String(sourceId || '').trim().toLowerCase()
    if (!value || value === 'all') return []
    const fromSource = this.platformsForSource(value)
    if (fromSource.length) return fromSource
    return []
  }

  snapshot(): SourceListSnapshot {
    const sources: SourceSnapshot[] = []
    for (const entry of this.entries.values()) {
      const runtime = entry.runtime
      sources.push({
        ...entry.meta,
        platforms: runtime.status === 'ready' ? runtime.toPlatformList() : entry.meta.platforms,
        status: runtime.status,
        error: runtime.error,
        stats: { ...runtime.stats },
      })
    }
    return {
      sources,
      total: sources.length,
      loading: this.queueRunning || this.currentId !== null,
      batch_current_id: this.currentId,
      batch_pending_ids: this.queue.map((item) => item.id),
    }
  }

  /** 插件卸载时释放所有子 VM。 */
  async dispose(): Promise<void> {
    if (this.queueTimer !== null) {
      clearTimeout(this.queueTimer)
      this.queueTimer = null
    }
    this.queue = []
    this.queueRunning = false
    this.currentId = null
    for (const entry of this.entries.values()) {
      try {
        await entry.runtime.unload()
      } catch {
        // ignore
      }
    }
    this.runtimeManager.refresh()
  }
}
