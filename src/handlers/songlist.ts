/** 歌单浏览路由。 */
import { parseQuery, type Router } from '@songloft/plugin-sdk'
import {
  getLeaderboardList,
  getLeaderboards,
  getSongList,
  getSongListDetail,
  getSongListSorts,
  getSongListTags,
  isPlatform,
  searchSongList,
  type PlatformId,
} from '../musicSdk/facade'
import type { AppContext } from './shared'
import { ALL_PLATFORMS, extractList, fixImageUrl, qualityOrDefault, toSongItem } from './shared'
import { withVoiceFields } from './search'
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

const RANDOM_PLAYLIST_DEFAULT_LIMIT = 20
/** 少于这个数的歌单不值得作为「播放音乐」的队列，换一个。 */
const RANDOM_PLAYLIST_MIN_SONGS = 3
/** 最多换几个平台重试，避免接口在坏平台上拖太久。 */
const RANDOM_PLAYLIST_MAX_PLATFORM_ATTEMPTS = 2

function pickRandom<T>(items: T[]): T | undefined {
  if (!items.length) return undefined
  return items[Math.floor(Math.random() * items.length)]
}

function shuffled<T>(items: T[]): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** 平台歌曲 → mi-song-harness 可直接入库的 topone 结构（去重、限长）。 */
function voiceSongItems(raw: any, platform: string, quality: string, limit: number): any[] {
  const { list } = extractList(raw)
  const seen = new Set<string>()
  const songs: any[] = []
  for (const song of list) {
    const item = withVoiceFields(toSongItem(song, platform, quality))
    const key = `${item.title}|${item.artist}`
    if (!item.title || item.title === '未知歌曲' || seen.has(key)) continue
    seen.add(key)
    songs.push(item)
    if (songs.length >= limit) break
  }
  return songs
}

/** 从歌单广场随机挑一个歌单并取详情；最多试两个列表页、每页两个歌单。 */
async function pickSquarePlaylist(platform: PlatformId, quality: string, limit: number): Promise<any | null> {
  const sorts = getSongListSorts(platform)
  const sortId = String(pickRandom(sorts)?.id ?? sorts[0]?.id ?? '')
  for (const page of shuffled([1, 2, 3]).slice(0, 2)) {
    let raw: any
    try {
      raw = await getSongList(platform, sortId, '', page)
    } catch (err) {
      songloft.log.warn(`[songlist] random playlist list failed: ${platform} page=${page}: ${(err as Error)?.message || err}`)
      continue
    }
    const { list } = extractList(raw)
    const candidates = shuffled(list.filter((item) => !!item && !!item.id && !!item.name)).slice(0, 2)
    for (const candidate of candidates) {
      const info = playlistItem(candidate, platform)
      try {
        const detail = await getSongListDetail(platform, info.id, 1)
        const songs = voiceSongItems(detail, platform, quality, limit)
        if (songs.length >= RANDOM_PLAYLIST_MIN_SONGS) {
          return { name: info.name, id: info.id, cover_url: info.cover_url, total: info.total, songs }
        }
      } catch (err) {
        songloft.log.warn(`[songlist] random playlist detail failed: ${platform}/${info.id}: ${(err as Error)?.message || err}`)
      }
    }
  }
  return null
}

/** 歌单广场取不到时，从排行榜随机挑一个榜单作为网络歌单。 */
async function pickLeaderboardPlaylist(platform: PlatformId, quality: string, limit: number): Promise<any | null> {
  let boards: any[] = []
  try {
    boards = await getLeaderboards(platform)
  } catch (err) {
    songloft.log.warn(`[songlist] random leaderboard list failed: ${platform}: ${(err as Error)?.message || err}`)
    return null
  }
  const candidates = shuffled(boards.filter((board) => !!board && !!(board.id ?? board.bangid))).slice(0, 2)
  for (const board of candidates) {
    const rawId = String(board.id ?? board.bangid)
    const bangid = rawId.includes('__') ? rawId.split('__').pop() || rawId : rawId
    try {
      const detail = await getLeaderboardList(platform, bangid, 1)
      const songs = voiceSongItems(detail, platform, quality, limit)
      if (songs.length >= RANDOM_PLAYLIST_MIN_SONGS) {
        return {
          name: String(board.name || '排行榜'),
          id: rawId,
          cover_url: '',
          total: extractList(detail).total,
          songs,
        }
      }
    } catch (err) {
      songloft.log.warn(`[songlist] random leaderboard detail failed: ${platform}/${rawId}: ${(err as Error)?.message || err}`)
    }
  }
  return null
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

  router.get('/api/songlist/random', async (req) => {
    const query = parseQuery(req.query)
    const requested = String(query.platform || '').trim().toLowerCase()
    if (requested && !isPlatform(requested)) return fail('platform 参数无效')
    // 只从已导入可用音源脚本的平台里挑，避免搜到歌却没有解析器。
    const ready = ALL_PLATFORMS.filter((platform) => ctx.runtimes.hasReadySource(platform))
    const platforms = requested ? ready.filter((platform) => platform === requested) : ready
    if (!platforms.length) return fail('没有已启用的音源脚本，无法随机播放网络歌单', 404)
    const limit = Math.min(Math.max(Number(query.limit) || RANDOM_PLAYLIST_DEFAULT_LIMIT, 1), 50)
    try {
      // 随机挑平台；某个平台歌单广场和榜单都取不到时，再换一个平台试，
      // 避免用户明明有多个可用音源却因为抽到坏平台而直接回落曲库。
      for (const platform of shuffled(platforms).slice(0, RANDOM_PLAYLIST_MAX_PLATFORM_ATTEMPTS)) {
        const platformQuality = ctx.runtimes.pickPlatformQuality(platform, qualityOrDefault(query.quality))
        const playlist = (await pickSquarePlaylist(platform, platformQuality, limit))
          || (await pickLeaderboardPlaylist(platform, platformQuality, limit))
        if (!playlist) continue
        songloft.log.info(`[songlist] random playlist: platform=${platform} name="${playlist.name}" songs=${playlist.songs.length}`)
        return ok({ platform, quality: platformQuality, ...playlist })
      }
      return fail('没有找到可播放的网络歌单', 404)
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
