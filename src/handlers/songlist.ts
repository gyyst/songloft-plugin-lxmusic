/** 歌单浏览路由。 */
import { parseQuery, type Router } from '@songloft/plugin-sdk'
import {
  getSongList,
  getSongListDetail,
  getSongListSorts,
  getSongListTags,
  isPlatform,
  searchSongList,
  type PlatformId,
} from '../musicSdk/facade'
import type { AppContext } from './shared'
import { extractList, fixImageUrl, qualityOrDefault, toSongItem } from './shared'
import { fail, ok } from './response'

function firstPlatform(ctx: AppContext, query: Record<string, string>): PlatformId | null {
  const direct = String(query.platform || '').trim().toLowerCase()
  if (isPlatform(direct)) return direct
  const sourceId = String(query.source_id || '').trim()
  if (sourceId) {
    const platforms = ctx.sources.resolvePlatforms(sourceId)
    const found = platforms.find(isPlatform)
    if (found) return found
  }
  return null
}

function pageNumber(value: unknown): number {
  const page = Number(value)
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
}

function playlistItem(raw: any, platform: string): any {
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name || '未命名歌单'),
    author: String(raw?.author || ''),
    cover_url: fixImageUrl(raw?.img || raw?.cover || ''),
    play_count: String(raw?.play_count || ''),
    total: Number(raw?.total) || 0,
    description: String(raw?.desc || raw?.description || ''),
    source: platform,
  }
}

export function registerSongListRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/songlist/tags', async (req) => {
    const query = parseQuery(req.query)
    const platform = firstPlatform(ctx, query)
    if (!platform) return fail('platform 参数无效')
    try {
      const tags = await getSongListTags(platform)
      return ok({
        platform,
        tags: Array.isArray(tags?.tags) ? tags.tags : [],
        hotTag: Array.isArray(tags?.hotTag) ? tags.hotTag : [],
        sorts: getSongListSorts(platform),
      })
    } catch (err) {
      return fail((err as Error)?.message || String(err), 500)
    }
  })

  router.get('/api/songlist/sorts', (req) => {
    const query = parseQuery(req.query)
    const platform = firstPlatform(ctx, query)
    if (!platform) return fail('platform 参数无效')
    return ok({ platform, sorts: getSongListSorts(platform) })
  })

  router.get('/api/songlist/list', async (req) => {
    const query = parseQuery(req.query)
    const platform = firstPlatform(ctx, query)
    if (!platform) return fail('platform 参数无效')
    const sorts = getSongListSorts(platform)
    const sortId = String(query.sort_id || query.sort || (sorts[0]?.id ?? '') || '')
    const tagId = String(query.tag_id || query.tag || '')
    const page = pageNumber(query.page)
    try {
      const raw = await getSongList(platform, sortId, tagId, page)
      const { list, total } = extractList(raw)
      return ok({
        platform,
        sort_id: sortId,
        tag_id: tagId,
        page,
        total,
        list: list.map((item) => playlistItem(item, platform)),
      })
    } catch (err) {
      return fail((err as Error)?.message || String(err), 500)
    }
  })

  router.get('/api/songlist/detail', async (req) => {
    const query = parseQuery(req.query)
    const platform = firstPlatform(ctx, query)
    if (!platform) return fail('platform 参数无效')
    const id = String(query.id || '').trim()
    if (!id) return fail('缺少 id')
    const page = pageNumber(query.page)
    const quality = qualityOrDefault(query.quality)
    try {
      const raw = await getSongListDetail(platform, id, page)
      const { list, total } = extractList(raw)
      return ok({
        platform,
        id,
        page,
        quality,
        total,
        info: raw && !Array.isArray(raw)
          ? {
              name: String(raw.name || raw.title || ''),
              cover_url: fixImageUrl(raw.img || raw.cover || ''),
              description: String(raw.desc || raw.description || ''),
            }
          : null,
        list: list.map((song) => toSongItem(song, platform, quality)),
      })
    } catch (err) {
      return fail((err as Error)?.message || String(err), 500)
    }
  })

  router.get('/api/songlist/search', async (req) => {
    const query = parseQuery(req.query)
    const platform = firstPlatform(ctx, query)
    if (!platform) return fail('platform 参数无效')
    const keyword = String(query.keyword || '').trim()
    if (!keyword) return fail('keyword 不能为空')
    const page = pageNumber(query.page)
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50)
    try {
      const raw = await searchSongList(platform, keyword, page, limit)
      const { list, total } = extractList(raw)
      return ok({
        platform,
        keyword,
        page,
        total,
        list: list.map((item) => playlistItem(item, platform)),
      })
    } catch (err) {
      return fail((err as Error)?.message || String(err), 400)
    }
  })
}
