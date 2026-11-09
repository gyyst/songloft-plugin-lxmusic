/** 搜索、字段归一化与匹配评分等共享逻辑。 */
import { isPlatform, normalizeSongInfo, search as sdkSearch, sources as sdkSources, type PlatformId } from '../musicSdk/facade'
import type { RuntimeManager } from '../engine'
import type { SourceManager } from '../source/manager'
import { QUALITY_ORDER, isMusicQuality } from '../engine/types'

export interface AppContext {
  sources: SourceManager
  runtimes: RuntimeManager
}

export const ALL_PLATFORMS: PlatformId[] = ['kw', 'kg', 'tx', 'wy', 'mg']

export function platformName(platform: string): string {
  return sdkSources.find((item) => item.id === platform)?.name || platform
}

export function qualityOrDefault(value: unknown): string {
  const quality = String(value || '').trim()
  return isMusicQuality(quality) ? quality : '320k'
}

/** "04:17" / 257 → 257 秒。 */
export function intervalToSeconds(value: unknown): number {
  if (typeof value === 'number' && isFinite(value)) return value > 0 ? Math.round(value) : 0
  const text = String(value == null ? '' : value).trim()
  if (!text) return 0
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text))
  const parts = text.split(':').map((part) => Number(part))
  if (!parts.length || parts.some((n) => !isFinite(n))) return 0
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0))
}

export function singerText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).join(' / ')
  const text = String(value == null ? '' : value).trim()
  return text
}

export function fixImageUrl(value: unknown): string {
  const url = String(value == null ? '' : value).trim()
  if (!url) return ''
  if (url.startsWith('//')) return 'https:' + url
  return url
}

/** 把平台歌曲信息转成统一结构（同时保留完整 songInfo 供 source_data 使用）。 */
export function toSongItem(raw: any, platform: string, quality: string): any {
  const info = normalizeSongInfo({ ...raw, source: platform }, platform)
  const title = String(info.name || info.songName || info.title || '').trim() || '未知歌曲'
  const artist = singerText(info.singer || info.artist)
  const album = String(info.albumName || info.album || '').trim()
  const duration = intervalToSeconds(info.interval ?? info.duration)
  const cover = fixImageUrl(info.img ?? info.Img ?? info.pic ?? info.Pic ?? info.cover ?? info.coverUrl ?? info.CoverUrl)
  return {
    title,
    artist,
    album,
    duration,
    cover_url: cover,
    platform,
    quality,
    interval: info.interval || '',
    source_data: { platform, quality, songInfo: info },
  }
}

/** 解析 source_id / platforms 参数，得到去重后的平台列表。 */
export function resolvePlatforms(ctx: AppContext, sourceId: unknown, explicitPlatforms?: unknown): PlatformId[] {
  const requested: string[] = []
  const push = (value: unknown) => {
    const text = String(value || '').trim()
    if (!text) return
    if (text.includes(',')) {
      text.split(',').forEach(push)
      return
    }
    if (isPlatform(text)) {
      if (!requested.includes(text)) requested.push(text)
      return
    }
    const fromSource = ctx.sources.resolvePlatforms(text)
    for (const platform of fromSource) {
      if (isPlatform(platform) && !requested.includes(platform)) requested.push(platform)
    }
  }
  if (Array.isArray(explicitPlatforms)) explicitPlatforms.forEach(push)
  else push(explicitPlatforms)
  push(sourceId)
  if (!requested.length) return ALL_PLATFORMS.slice()
  return requested.filter(isPlatform) as PlatformId[]
}

/** 并行搜索多个平台，交错合并结果。 */
export async function searchPlatforms(
  platforms: PlatformId[],
  keyword: string,
  page = 1,
  pageSize = 20,
): Promise<any[]> {
  const unique = Array.from(new Set(platforms))
  const settled = await Promise.allSettled(
    unique.map((platform) => sdkSearch(platform, keyword, page, pageSize)),
  )
  const lists: any[][] = []
  const errors: string[] = []
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]
    if (result.status === 'fulfilled') {
      lists.push(result.value)
    } else {
      lists.push([])
      errors.push(`${platformName(unique[i])}: ${(result.reason as Error)?.message || result.reason}`)
    }
  }
  const max = lists.reduce((n, list) => Math.max(n, list.length), 0)
  const merged: any[] = []
  for (let index = 0; index < max; index++) {
    for (let p = 0; p < lists.length; p++) {
      if (lists[p][index]) merged.push(lists[p][index])
    }
  }
  if (!merged.length && errors.length) throw new Error(errors.join('；'))
  return merged
}

function normalizeText(value: unknown): string {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, '')
    .replace(/[\s\-_.,，。·、'"!！?？:：;；/\\|&+~`@#$%^*=\[\]{}<>《》「」『』【】]/g, '')
}

/** 0~1 的文本相似度：完全相等 / 包含 / 二元组 Dice 系数。 */
export function textSimilarity(a: unknown, b: unknown): number {
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) {
    return 0.75 + 0.2 * (Math.min(left.length, right.length) / Math.max(left.length, right.length))
  }
  if (left.length < 2 || right.length < 2) return 0
  const bigrams = new Map<string, number>()
  for (let i = 0; i < left.length - 1; i++) {
    const key = left.slice(i, i + 2)
    bigrams.set(key, (bigrams.get(key) || 0) + 1)
  }
  let hit = 0
  for (let i = 0; i < right.length - 1; i++) {
    const key = right.slice(i, i + 2)
    const count = bigrams.get(key) || 0
    if (count > 0) {
      hit++
      bigrams.set(key, count - 1)
    }
  }
  return (2 * hit) / (left.length + right.length - 2)
}

export interface MatchHint {
  title: string
  artist?: string
  duration?: number
}

/** 候选歌曲与提示信息的匹配分。 */
export function scoreMatch(item: any, hint: MatchHint): number {
  const titleScore = textSimilarity(item.title, hint.title)
  const artistScore = hint.artist ? textSimilarity(item.artist, hint.artist) : 0
  let score = titleScore * 0.72 + artistScore * 0.28
  if (hint.duration && item.duration) {
    const diff = Math.abs(Number(item.duration) - Number(hint.duration))
    if (diff <= 2) score += 0.18
    else if (diff <= 5) score += 0.12
    else if (diff <= 12) score += 0.05
    else if (diff > 45) score -= 0.08
  }
  // 标题完全不像时，即使歌手匹配也不应算作同一首。
  if (titleScore < 0.35) score -= 0.25
  return score
}

export interface BestMatch {
  item: any
  score: number
}

/** 从搜索结果中挑选最匹配的一首。 */
export function pickBestMatch(items: any[], hint: MatchHint): BestMatch | null {
  let best: BestMatch | null = null
  for (const item of items) {
    const score = scoreMatch(item, hint)
    if (!best || score > best.score) best = { item, score }
  }
  return best
}

/** 关键词搜索取最佳结果（topone 用）。 */
export function pickBestForKeyword(items: any[], keyword: string): BestMatch | null {
  let best: BestMatch | null = null
  for (const item of items) {
    const score = textSimilarity(item.title, keyword) * 0.8 + textSimilarity(item.artist, keyword) * 0.2
    if (!best || score > best.score) best = { item, score }
  }
  return best
}

/** 从歌曲列表响应中提取数组与总数。 */
export function extractList(result: any): { list: any[]; total: number } {
  if (Array.isArray(result)) return { list: result, total: result.length }
  const list = Array.isArray(result?.list) ? result.list : Array.isArray(result?.songs) ? result.songs : []
  const total = Number(result?.total)
  return { list, total: isFinite(total) && total > 0 ? total : list.length }
}

/** 检查音质是否合法，用于 UI 选项。 */
export function qualityOptions(): string[] {
  return QUALITY_ORDER.slice()
}
