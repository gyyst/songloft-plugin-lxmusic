/** 音源索引与脚本内容的 storage 持久化。 */
import type { SourceMeta } from './types'

const INDEX_KEY = 'source_index'
const SCRIPT_PREFIX = 'source_script_'

function sanitizeMeta(raw: any): SourceMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  const name = String(raw.name || '').trim()
  if (!id || !name) return null
  const platforms = Array.isArray(raw.platforms)
    ? raw.platforms
        .filter((p: any) => p && typeof p === 'object')
        .map((p: any) => ({
          platform: String(p.platform || '').toLowerCase(),
          type: String(p.type || 'music'),
          actions: Array.isArray(p.actions) ? p.actions.map((a: any) => String(a)) : ['musicUrl'],
          qualitys: Array.isArray(p.qualitys) ? p.qualitys.map((q: any) => String(q)) : [],
        }))
        .filter((p: any) => p.platform)
    : []
  return {
    id,
    name,
    version: String(raw.version || '0.0.0'),
    description: String(raw.description || ''),
    author: String(raw.author || ''),
    homepage: String(raw.homepage || ''),
    enabled: raw.enabled !== false,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    size: Number(raw.size) || 0,
    fileName: raw.fileName ? String(raw.fileName) : undefined,
    platforms,
  }
}

export class SourceStorage {
  async loadIndex(): Promise<SourceMeta[]> {
    const raw = await songloft.storage.get(INDEX_KEY)
    if (!Array.isArray(raw)) return []
    const out: SourceMeta[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      const meta = sanitizeMeta(item)
      if (!meta || seen.has(meta.id)) continue
      seen.add(meta.id)
      out.push(meta)
    }
    return out
  }

  async saveIndex(list: SourceMeta[]): Promise<void> {
    await songloft.storage.set(INDEX_KEY, list)
  }

  async loadScript(id: string): Promise<string> {
    const raw = await songloft.storage.get(SCRIPT_PREFIX + id)
    return typeof raw === 'string' ? raw : ''
  }

  async saveScript(id: string, script: string): Promise<void> {
    await songloft.storage.set(SCRIPT_PREFIX + id, script)
  }

  async deleteScript(id: string): Promise<void> {
    try {
      await songloft.storage.delete(SCRIPT_PREFIX + id)
    } catch {
      // 不存在时忽略
    }
  }
}
