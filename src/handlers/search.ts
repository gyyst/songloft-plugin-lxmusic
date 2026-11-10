/** 主程序契约端点（搜索/播放链接/导入）与 Direct 工具端点。 */
import { createMusicUrlHandler, createSearchHandler, parseQuery, type Router } from '@songloft/plugin-sdk'
import { getLyric, isPlatform, type PlatformId } from '../musicSdk/facade'
import { DEFAULT_QUALITY, ENTRY_PATH, MAX_IMPORT_SONGS } from '../constants'
import { Buffer, base64Encode, base64Decode } from '../utils/buffer'
import { callHostAPI } from '../utils/http'
import { parseJsonBody } from '../utils/text'
import type { AppContext, MatchHint } from './shared'
import {
  ALL_PLATFORMS,
  intervalToSeconds,
  pickBestForKeyword,
  pickBestMatch,
  qualityOrDefault,
  resolvePlatforms,
  searchPlatforms,
  singerText,
  toSongItem,
  fixImageUrl,
} from './shared'
import { fail, ok } from './response'

interface SearchContext {
  platforms: PlatformId[]
  quality: string
}

async function searchSongItems(
  platforms: PlatformId[],
  keyword: string,
  page: number,
  pageSize: number,
  quality: string,
  timeoutMs = 0,
): Promise<any[]> {
  const raw = await searchPlatforms(platforms, keyword, page, pageSize, timeoutMs)
  return raw.map((song) => toSongItem(song, String(song?.source || platforms[0] || ''), quality))
}

/** 用 source_data 解析真实播放 URL（供 /api/music/url 与 Direct 共用）。 */
async function resolveSourceData(ctx: AppContext, sourceData: any): Promise<{ url: string; headers?: Record<string, string>; quality: string; sourceId: string; sourceName: string }> {
  // 宿主存库时 source_data 是字符串；/api/music/url 契约是对象。
  // 两种形态都接受，避免 remote 曲目回放时因序列化差异解析失败。
  if (typeof sourceData === 'string') {
    try {
      sourceData = JSON.parse(sourceData)
    } catch {
      throw new Error('source_data 不是合法的 JSON')
    }
  }
  if (!sourceData || typeof sourceData !== 'object') throw new Error('source_data 不能为空')
  const platform = String(sourceData.platform || sourceData.source || '').toLowerCase()
  if (!isPlatform(platform)) throw new Error('source_data 缺少合法的 platform')
  const quality = qualityOrDefault(sourceData.quality)
  const songInfo = sourceData.songInfo || sourceData.song || sourceData
  return await ctx.runtimes.getMusicUrl(platform, quality, songInfo)
}

function normalizePlatform(value: unknown): string {
  return String(value == null ? '' : value).trim().toLowerCase()
}

/** 把 /api/songs/import 的入参统一成 {platform, quality, songInfo, item}。 */
function normalizeImportSong(raw: any): { platform: string; quality: string; songInfo: any; item: any } | null {
  if (!raw || typeof raw !== 'object') return null
  let sourceData = raw.source_data ?? raw.sourceData
  if (typeof sourceData === 'string') {
    try {
      sourceData = JSON.parse(sourceData)
    } catch {
      sourceData = null
    }
  }
  let platform = ''
  let quality = DEFAULT_QUALITY
  let songInfo: any = null
  if (sourceData && typeof sourceData === 'object' && sourceData.songInfo) {
    platform = normalizePlatform(sourceData.platform || sourceData.source)
    quality = qualityOrDefault(sourceData.quality)
    songInfo = sourceData.songInfo
  } else if (raw.platform && raw.songInfo) {
    platform = normalizePlatform(raw.platform)
    quality = qualityOrDefault(raw.quality)
    songInfo = raw.songInfo
  } else if (raw.platform && (raw.songmid || raw.musicId || raw.hash || raw.copyrightId)) {
    platform = normalizePlatform(raw.platform)
    quality = qualityOrDefault(raw.quality)
    songInfo = raw
  }
  if (!isPlatform(platform) || !songInfo || typeof songInfo !== 'object') return null
  return { platform, quality, songInfo, item: raw }
}

/** 取出歌词接口真正需要的字段，避免 URL 过长。 */
const LYRIC_FIELDS = [
  'name',
  'singer',
  'albumName',
  'interval',
  '_interval',
  'duration',
  'songmid',
  'musicId',
  'hash',
  'copyrightId',
  'albumId',
  'albumMid',
  'strMediaMid',
  'songId',
  'lrcUrl',
  'mrcUrl',
  'source',
]

function compactSongInfo(info: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of LYRIC_FIELDS) {
    const value = info?.[key]
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

function buildLyricPath(platform: string, songInfo: any): string {
  const json = JSON.stringify(compactSongInfo(songInfo))
  const si = base64Encode(Buffer.from(json, 'utf8'))
  return `/api/v1/jsplugin/${ENTRY_PATH}/api/direct/lyric?platform=${encodeURIComponent(platform)}&si=${encodeURIComponent(si)}`
}

/** 跨会话稳定的去重键：优先 songmid → musicId → hash → copyrightId。 */
function buildDedupKey(platform: string, songInfo: any): string {
  const value = songInfo?.songmid ?? songInfo?.musicId ?? songInfo?.hash ?? songInfo?.copyrightId
  if (value === undefined || value === null || value === '') return ''
  return `${platform}:${String(value)}`
}

/**
 * 补齐语音助手（如 mi-song-harness）消费 topone 结果所需的字段：
 * - plugin_entry_path：告诉宿主播放时回调哪个插件解析 URL；
 * - dedup_key：入库去重；
 * - lyric/lyric_source：歌词 URL（宿主 LyricFetcher 格式）。
 * 缺 plugin_entry_path 时，解析型结果入 remote 库后将无法回放。
 */
export function withVoiceFields(item: any): any {
  const platform = String(item?.platform || '')
  const songInfo = item?.source_data?.songInfo || {}
  const lyricPath = platform && isPlatform(platform) ? buildLyricPath(platform, songInfo) : ''
  return {
    ...item,
    plugin_entry_path: ENTRY_PATH,
    dedup_key: buildDedupKey(platform, songInfo),
    ...(lyricPath ? { lyric: lyricPath, lyric_source: 'url' } : {}),
  }
}

/** 语音助手会额外下发结构化的 title/artist/duration，用于在候选里挑更准的一首。 */
function normalizeVoiceHint(raw: any): MatchHint | null {
  if (!raw || typeof raw !== 'object') return null
  const title = String(raw.title || '').trim()
  if (!title) return null
  const artist = String(raw.artist || '').trim()
  const duration = Number(raw.duration)
  return {
    title,
    ...(artist ? { artist } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
  }
}

function buildImportPayload(ctx: AppContext, items: any[], withLyric: boolean): any[] {
  const payload: any[] = []
  for (const raw of items) {
    const normalized = normalizeImportSong(raw)
    if (!normalized) continue
    const { platform, quality, songInfo, item } = normalized
    if (!ctx.runtimes.hasReadySource(platform)) {
      // 没有音源也能入库，但播放时会失败；这里不阻塞导入，交给运行时兜底。
    }
    const dedupKey = buildDedupKey(platform, songInfo)
    const entry: any = {
      title: String(item.title || songInfo.name || songInfo.songName || '').trim() || '未知歌曲',
      artist: String(item.artist || singerText(songInfo.singer) || ''),
      album: String(item.album || songInfo.albumName || songInfo.album || ''),
      cover_url: fixImageUrl(item.cover_url || item.coverUrl || songInfo.img || songInfo.pic || ''),
      duration: intervalToSeconds(item.duration ?? songInfo.interval ?? songInfo.duration),
      plugin_entry_path: ENTRY_PATH,
      source_data: JSON.stringify({ platform, quality, songInfo }),
      dedup_key: dedupKey,
    }
    if (item.lyric && typeof item.lyric === 'string' && item.lyric.trim()) {
      const text = item.lyric.trim()
      const looksLikeLrc = text.includes('[') || text.includes('\n')
      entry.lyric = text
      entry.lyric_source = looksLikeLrc ? 'text' : 'url'
    } else if (withLyric) {
      entry.lyric = buildLyricPath(platform, songInfo)
      entry.lyric_source = 'url'
    }
    payload.push(entry)
  }
  return payload
}

async function addSongsToPlaylist(body: any, songs: any[]): Promise<{ playlistId?: number; playlistName?: string; warning?: string }> {
  const ids = songs
    .map((song) => Number(song?.id))
    .filter((id) => Number.isFinite(id) && id > 0)
  if (!ids.length) return {}
  let playlistId = Number(body.playlist_id)
  let playlistName = String(body.playlist_name || '').trim()
  if ((!Number.isFinite(playlistId) || playlistId <= 0) && !playlistName) return {}

  try {
    if (!Number.isFinite(playlistId) || playlistId <= 0) {
      const existing = await songloft.playlists.search(playlistName, { limit: 20 })
      const matched = existing.find((p: any) => String(p.name || '').trim() === playlistName)
      if (matched) {
        playlistId = matched.id
      } else {
        const created = await songloft.playlists.create({ name: playlistName })
        playlistId = created.id
      }
    }
    const result = await songloft.playlists.addSongs(playlistId, ids)
    return {
      playlistId,
      playlistName,
      warning: result.skipped ? `有 ${result.skipped} 首歌因类型不兼容或已存在被跳过` : undefined,
    }
  } catch (err) {
    return {
      playlistId: playlistId > 0 ? playlistId : undefined,
      playlistName,
      warning: '歌曲已入库，但加入歌单失败: ' + ((err as Error)?.message || String(err)),
    }
  }
}

export function registerSearchRoutes(router: Router, ctx: AppContext): void {
  let pendingSearchContext: SearchContext | null = null

  const sdkSearchHandler = createSearchHandler({
    search: async (keyword, page, pageSize) => {
      const context = pendingSearchContext
      pendingSearchContext = null
      const platforms = context?.platforms?.length ? context.platforms : ALL_PLATFORMS.slice()
      const quality = context?.quality || DEFAULT_QUALITY
      const items = await searchSongItems(platforms, keyword, page || 1, pageSize || 20, quality)
      return items as any
    },
  })

  const sdkMusicUrlHandler = createMusicUrlHandler({
    resolveUrl: async (sourceData) => {
      const resolved = await resolveSourceData(ctx, sourceData)
      return resolved.headers ? { url: resolved.url, headers: resolved.headers } : resolved.url
    },
    fallbackSearch: async (hint) => {
      try {
        const keyword = [hint.title, hint.artist].filter(Boolean).join(' ').trim()
        if (!keyword) return null
        const raw = await searchPlatforms(ALL_PLATFORMS, keyword, 1, 8)
        const items = raw.map((song) => toSongItem(song, String(song?.source || ''), DEFAULT_QUALITY))
        const best = pickBestMatch(items, hint)
        if (!best || best.score < 0.55) return null
        const item = best.item
        const platform = String(item.platform || '')
        if (!isPlatform(platform)) return null
        const quality = ctx.runtimes.pickPlatformQuality(platform, item.quality || DEFAULT_QUALITY)
        return {
          source_data: {
            platform,
            quality,
            songInfo: item.source_data?.songInfo || {},
          },
          title: item.title,
          artist: item.artist,
        }
      } catch {
        return null
      }
    },
  })

  // 主程序契约：POST /api/search
  router.post('/api/search', async (req) => {
    const body = parseJsonBody(req.body)
    const platforms = resolvePlatforms(ctx, body.source_id, body.platforms)
    pendingSearchContext = { platforms, quality: qualityOrDefault(body.quality) }
    try {
      return await sdkSearchHandler(req, {})
    } finally {
      pendingSearchContext = null
    }
  })

  // 主程序契约：POST /api/music/url
  router.post('/api/music/url', async (req) => {
    return await sdkMusicUrlHandler(req, {})
  })

  // 批量导入歌曲到宿主机库
  router.post('/api/songs/import', async (req) => {
    try {
      const body = parseJsonBody(req.body)
      const items = Array.isArray(body.songs) ? body.songs : Array.isArray(body.items) ? body.items : []
      if (!items.length) return fail('songs 不能为空')
      if (items.length > MAX_IMPORT_SONGS) return fail(`单次最多导入 ${MAX_IMPORT_SONGS} 首歌曲`)
      const withLyric = body.with_lyric !== false
      const payload = buildImportPayload(ctx, items, withLyric)
      if (!payload.length) return fail('没有可导入的有效歌曲（source_data 缺失或格式错误）')

      const response = await callHostAPI('/api/v1/songs/remote', {
        method: 'POST',
        body: payload,
        timeoutMs: 60000,
      })
      const songs = Array.isArray(response?.songs) ? response.songs : []
      const playlist = await addSongsToPlaylist(body, songs)
      const data = {
        added: Number(response?.count) || songs.length,
        requested: payload.length,
        skipped: payload.length - (Number(response?.count) || songs.length),
        songs,
        playlist_id: playlist.playlistId ?? null,
        playlist_name: playlist.playlistName ?? null,
      }
      if (playlist.warning) return ok(data, { warning: playlist.warning })
      return ok(data)
    } catch (err) {
      return fail((err as Error)?.message || String(err), 500)
    }
  })

  // 三合一：搜索并选出最佳匹配。同时用作 mi-song-harness 等语音助手的外部搜索源：
  // 请求 {keyword, hint?, quality}，返回可直接入库/回放的 topone 结构。
  router.post('/api/search/topone', async (req) => {
    try {
      const body = parseJsonBody(req.body)
      const keyword = String(body.keyword || '').trim()
      if (!keyword) return fail('keyword 不能为空')
      const platforms = resolvePlatforms(ctx, body.source_id, body.platforms)
      const quality = qualityOrDefault(body.quality)
      const pageSize = Math.min(Math.max(Number(body.page_size) || 10, 1), 30)
      // mi-song-harness 默认 6 秒超时：给单平台限时 4.5 秒，保证整体能按期返回。
      const items = await searchSongItems(platforms, keyword, 1, pageSize, quality, 4500)
      if (!items.length) return fail('没有找到匹配的歌曲', 404)

      // 优先从已有就绪音源的平台里挑：搜得到但没导入对应音源脚本的结果，
      // 在语音点播时必然解析失败，表现为「小爱说在搜但没声音」。
      const playable = items.filter((item) => ctx.runtimes.hasReadySource(String(item.platform || '')))
      const pool = playable.length ? playable : items

      const hint = normalizeVoiceHint(body.hint)
      let best = hint ? pickBestMatch(pool, hint) : null
      if (!best || best.score < 0.35) best = pickBestForKeyword(pool, keyword)
      const item = best?.item || pool[0]
      return ok({
        ...withVoiceFields(item),
        score: Number((best?.score || 0).toFixed(3)),
        candidates: items.slice(0, 10).map(withVoiceFields),
      })
    } catch (err) {
      return fail((err as Error)?.message || String(err), 500)
    }
  })

  // Direct：解析播放链接（不走主程序契约，返回裸数据）
  router.post('/api/direct/music/url', async (req) => {
    try {
      const body = parseJsonBody(req.body)
      const sourceData = body.source_data || body.sourceData || body
      const resolved = await resolveSourceData(ctx, sourceData)
      return ok({
        url: resolved.url,
        headers: resolved.headers || {},
        quality: resolved.quality,
        source_id: resolved.sourceId,
        source_name: resolved.sourceName,
      })
    } catch (err) {
      return fail((err as Error)?.message || String(err), 404)
    }
  })

  // Direct：歌词。默认返回宿主 LyricFetcher 需要的 JSON envelope；
  // format=text 时返回纯 LRC，方便前端直接展示。
  router.get('/api/direct/lyric', async (req) => {
    const query = parseQuery(req.query)
    const platform = normalizePlatform(query.platform)
    if (!isPlatform(platform)) return fail('platform 参数无效')
    let songInfo: any = null
    if (query.si) {
      try {
        const bytes = base64Decode(query.si)
        songInfo = JSON.parse(new Buffer(bytes).toString('utf8'))
      } catch {
        songInfo = null
      }
    }
    if (!songInfo) {
      const keys = ['name', 'singer', 'albumName', 'interval', 'songmid', 'musicId', 'hash', 'copyrightId', 'albumId', 'lrcUrl', 'mrcUrl']
      const built: Record<string, string> = {}
      for (const key of keys) {
        if (query[key]) built[key] = query[key]
      }
      songInfo = Object.keys(built).length ? built : null
    }
    if (!songInfo) return fail('缺少歌曲信息')
    try {
      const lyric = await getLyric(platform, songInfo)
      const data: Record<string, string> = {}
      if (lyric.lyric) data.lyric = lyric.lyric
      if (lyric.tlyric) data.tlyric = lyric.tlyric
      if (!data.lyric && !data.tlyric) return fail('未找到歌词', 404)
      if (String(query.format || '').toLowerCase() === 'text') {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
          body: data.lyric || '',
        }
      }
      return ok(data)
    } catch (err) {
      return fail((err as Error)?.message || String(err), 404)
    }
  })
}
