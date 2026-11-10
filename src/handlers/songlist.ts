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
/**
 * 插件被宿主唤醒时，音源脚本还在后台排队加载（首个约 100ms 后开始）。
 * 「播放音乐」的第一句请求往往正好撞上这个窗口，不能直接 404 回落曲库。
 */
const RANDOM_PLAYLIST_READY_WAIT_MS = 5000
/**
 * 平台列表页实测 kw 0.6s、mg 3.5s、wy 3.1s、kg 7.7s、tx 9.8s。
 * 并发竞速取最先返回的平台，整体只等这么久，慢平台不拖累语音指令。
 */
const RANDOM_PLAYLIST_LIST_TIMEOUT_MS = 5000
/** 单个歌单详情实测 kw 3.6~9.3s；同时取两个候选，先到先用。 */
const RANDOM_PLAYLIST_DETAIL_TIMEOUT_MS = 10000
/** 榜单详情实测 20s 以上，只留很短的最后兜底窗口，不能让它拖过语音超时。 */
const RANDOM_PLAYLIST_LEADERBOARD_TIMEOUT_MS = 4000
/** 列表页并发竞速的平台数量上限。 */
const RANDOM_PLAYLIST_LIST_PLATFORMS = 3
/**
 * 随机歌单优先使用直链解析更稳定的平台。
 * mg 的歌单接口正常，但常见自定义音源对 migu 直链支持不完整
 * （gdstudio 返回 source is not supported），拿到歌单也播不出声。
 */
const RANDOM_PLAYLIST_PREFERRED_PLATFORMS: PlatformId[] = ['kw', 'tx', 'wy']
/**
 * 缓存已取到的歌单，后续「播放音乐」直接返回，避免每次现查 5~10 秒。
 * 只缓存本进程生命周期内的数据，不写存储。
 */
const RANDOM_PLAYLIST_CACHE_TTL_MS = 30 * 60_000
const RANDOM_PLAYLIST_CACHE_SIZE = 3

interface RandomPlaylist {
  platform: PlatformId
  quality: string
  name: string
  id: string
  cover_url: string
  total: number
  songs: any[]
}

interface CachedRandomPlaylist {
  savedAt: number
  playlist: RandomPlaylist
}

const randomPlaylistCache: CachedRandomPlaylist[] = []
let randomPlaylistPrefetching = false

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

function readyPlatforms(ctx: AppContext, requested: string): PlatformId[] {
  const ready = ALL_PLATFORMS.filter((platform) => ctx.runtimes.hasReadySource(platform))
  return requested ? ready.filter((platform) => platform === requested) : ready
}

/**
 * 并发任务竞速：第一个成功的结果立即返回；全部失败或超时返回 null。
 * 落败的任务继续在后台完成，其拒绝被消费掉，不会产生未处理异常。
 */
function firstFulfilled<T>(tasks: Promise<T>[], timeoutMs: number, label: string): Promise<T | null> {
  if (!tasks.length) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    let pending = tasks.length
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: T | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => {
      songloft.log.warn(`[songlist] ${label} timeout (${timeoutMs}ms)`)
      finish(null)
    }, timeoutMs)
    for (const task of tasks) {
      task.then(
        (value) => finish(value),
        (err) => {
          pending -= 1
          songloft.log.warn(`[songlist] ${label} failed: ${(err as Error)?.message || err}`)
          if (pending === 0) finish(null)
        },
      )
    }
  })
}

function cacheKey(playlist: RandomPlaylist): string {
  return `${playlist.platform}:${playlist.id}`
}

/**
 * 选出参与竞速的平台：优先直链健康的首选平台；首选都不可用时退回其他候选，
 * 不能因为健康度记录把自己筛成空集。显式指定平台时该平台就是唯一候选。
 */
function pickPlaylistPlatforms(ctx: AppContext, platforms: PlatformId[]): PlatformId[] {
  const healthy = platforms.filter((platform) => ctx.runtimes.isPlatformUrlHealthy(platform))
  const available = healthy.length ? healthy : platforms
  const preferred = RANDOM_PLAYLIST_PREFERRED_PLATFORMS.filter((platform) => available.includes(platform))
  return shuffled(preferred.length ? preferred : available).slice(0, RANDOM_PLAYLIST_LIST_PLATFORMS)
}

function rememberRandomPlaylist(playlist: RandomPlaylist): void {
  const now = Date.now()
  const key = cacheKey(playlist)
  for (let i = randomPlaylistCache.length - 1; i >= 0; i--) {
    const entry = randomPlaylistCache[i]
    if (now - entry.savedAt > RANDOM_PLAYLIST_CACHE_TTL_MS || cacheKey(entry.playlist) === key) {
      randomPlaylistCache.splice(i, 1)
    }
  }
  randomPlaylistCache.push({ savedAt: now, playlist })
  while (randomPlaylistCache.length > RANDOM_PLAYLIST_CACHE_SIZE) randomPlaylistCache.shift()
}

/** 取一个缓存的歌单并从缓存移除，避免连续两次「播放音乐」播到同一张歌单。 */
function takeCachedRandomPlaylist(ctx: AppContext, platforms: PlatformId[]): RandomPlaylist | null {
  const now = Date.now()
  // 近期直链解析失败的平台不再从缓存取，避免继续播上一轮取到的不可播歌单。
  const healthy = platforms.filter((platform) => ctx.runtimes.isPlatformUrlHealthy(platform))
  const allowed = healthy.length ? healthy : platforms
  // 先清理过期项，再收集可用项，避免一边删除一边记录下标导致下标错位。
  for (let i = randomPlaylistCache.length - 1; i >= 0; i--) {
    if (now - randomPlaylistCache[i].savedAt > RANDOM_PLAYLIST_CACHE_TTL_MS) randomPlaylistCache.splice(i, 1)
  }
  const usable: Array<{ entry: CachedRandomPlaylist; index: number }> = []
  for (let i = 0; i < randomPlaylistCache.length; i++) {
    const entry = randomPlaylistCache[i]
    if (allowed.includes(entry.playlist.platform) && entry.playlist.songs.length >= RANDOM_PLAYLIST_MIN_SONGS) {
      usable.push({ entry, index: i })
    }
  }
  const picked = pickRandom(usable)
  if (!picked) return null
  randomPlaylistCache.splice(picked.index, 1)
  return picked.entry.playlist
}

/** 后台补一张歌单进缓存，让下一次「播放音乐」可以立即返回。 */
function refillRandomPlaylistCache(ctx: AppContext, platforms: PlatformId[], quality: string, limit: number): void {
  if (randomPlaylistPrefetching || randomPlaylistCache.length >= RANDOM_PLAYLIST_CACHE_SIZE) return
  randomPlaylistPrefetching = true
  void fetchPlaylistFromAnyPlatform(ctx, platforms, quality, limit)
    .then((playlist) => {
      if (!playlist) return
      rememberRandomPlaylist(playlist)
      songloft.log.info(`[songlist] random playlist cached: platform=${playlist.platform} name="${playlist.name}" songs=${playlist.songs.length}`)
    })
    .catch((err) => {
      songloft.log.warn(`[songlist] random playlist prefetch failed: ${(err as Error)?.message || err}`)
    })
    .finally(() => {
      randomPlaylistPrefetching = false
    })
}

/**
 * 没有 ready 音源时等待后台加载完成（有上限）。已加载的音源会被复用；
 * 超时后后台加载继续，下一次「播放音乐」可以直接命中。
 */
async function waitForReadyPlatforms(ctx: AppContext, requested: string): Promise<void> {
  if (readyPlatforms(ctx, requested).length) return
  const candidates = requested ? [requested] : shuffled(ALL_PLATFORMS)
  const loading = (async () => {
    for (const platform of candidates) {
      try {
        await ctx.sources.loadPendingForPlatform(platform)
      } catch (err) {
        songloft.log.warn(`[songlist] random playlist source load failed: ${platform}: ${(err as Error)?.message || err}`)
      }
      if (readyPlatforms(ctx, requested).length) return
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    loading,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RANDOM_PLAYLIST_READY_WAIT_MS)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
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

/** 从某个平台随机取一页歌单广场列表。 */
async function listPlatformPlaylists(platform: PlatformId): Promise<{ platform: PlatformId; items: any[] }> {
  const sorts = getSongListSorts(platform)
  const sortId = String(pickRandom(sorts)?.id ?? sorts[0]?.id ?? '')
  const page = shuffled([1, 2, 3])[0]
  const raw = await getSongList(platform, sortId, '', page)
  const { list } = extractList(raw)
  const items = list.filter((item: any) => !!item && !!item.id && !!item.name)
  if (!items.length) throw new Error(`empty playlist list (${platform})`)
  return { platform, items }
}

/**
 * 随机取一张网络歌单。
 * 平台列表页并发竞速（慢平台不拖累语音指令），详情也并发取两个候选；
 * 每段都有独立预算，整体稳定落在宿主与 mi-song-harness 的超时之内。
 */
async function fetchPlaylistFromAnyPlatform(
  ctx: AppContext,
  platforms: PlatformId[],
  quality: string,
  limit: number,
): Promise<RandomPlaylist | null> {
  const racers = pickPlaylistPlatforms(ctx, platforms)
  const listed = await firstFulfilled(
    racers.map((platform) => listPlatformPlaylists(platform)),
    RANDOM_PLAYLIST_LIST_TIMEOUT_MS,
    'playlist list',
  )
  if (listed) {
    const platform = listed.platform
    const platformQuality = ctx.runtimes.pickPlatformQuality(platform, quality)
    // 同一页里并发取两个歌单详情，先成功的先用；落败的任务自行结束。
    const candidates = shuffled(listed.items).slice(0, 2).map((item) => playlistItem(item, platform))
    const detail = await firstFulfilled(
      candidates.map(async (info): Promise<RandomPlaylist> => {
        const raw = await getSongListDetail(platform, info.id, 1)
        const songs = voiceSongItems(raw, platform, platformQuality, limit)
        if (songs.length < RANDOM_PLAYLIST_MIN_SONGS) throw new Error(`playlist too small: ${platform}/${info.id}`)
        return {
          platform,
          quality: platformQuality,
          name: info.name,
          id: info.id,
          cover_url: info.cover_url,
          total: info.total,
          songs,
        }
      }),
      RANDOM_PLAYLIST_DETAIL_TIMEOUT_MS,
      'playlist detail',
    )
    if (detail) return detail
  }
  // 歌单广场整体失败时才试排行榜；实测榜单歌曲列表常在 20s 以上，只给很短预算。
  return await firstFulfilled(
    pickPlaylistPlatforms(ctx, platforms).slice(0, 2).map(async (platform): Promise<RandomPlaylist> => {
      const platformQuality = ctx.runtimes.pickPlatformQuality(platform, quality)
      const playlist = await pickLeaderboardPlaylist(platform, platformQuality, limit)
      if (!playlist) throw new Error(`no leaderboard playlist (${platform})`)
      return { platform, quality: platformQuality, ...playlist }
    }),
    RANDOM_PLAYLIST_LEADERBOARD_TIMEOUT_MS,
    'leaderboard playlist',
  )
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
    await waitForReadyPlatforms(ctx, requested)
    const platforms = readyPlatforms(ctx, requested)
    if (!platforms.length) return fail('没有已启用的音源脚本，无法随机播放网络歌单', 404)
    const limit = Math.min(Math.max(Number(query.limit) || RANDOM_PLAYLIST_DEFAULT_LIMIT, 1), 50)
    const quality = qualityOrDefault(query.quality)
    const startedAt = Date.now()
    try {
      // 已缓存时立即返回（实测现查详情 5~10 秒，语音指令等不起）；后台补下一张。
      const cached = takeCachedRandomPlaylist(ctx, platforms)
      if (cached) {
        songloft.log.info(`[songlist] random playlist from cache: platform=${cached.platform} name="${cached.name}" songs=${cached.songs.length}`)
        refillRandomPlaylistCache(ctx, platforms, quality, limit)
        return ok(cached)
      }
      const playlist = await fetchPlaylistFromAnyPlatform(ctx, platforms, quality, limit)
      if (!playlist) return fail('没有找到可播放的网络歌单', 404)
      songloft.log.info(
        `[songlist] random playlist: platform=${playlist.platform} name="${playlist.name}" songs=${playlist.songs.length} dur_ms=${Date.now() - startedAt}`,
      )
      rememberRandomPlaylist(playlist)
      refillRandomPlaylistCache(ctx, platforms, quality, limit)
      return ok(playlist)
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
