/**
 * musicSdk 顶层门面（移植自 lxserver `musicSdk/index.js` 的元数据部分）。
 *
 * 只暴露元数据能力：搜索、歌词、歌单、排行榜、热搜、联想。
 * 播放直链由 engine 侧的自定义音源脚本解析，这里没有 getMusicUrl。
 */
// @ts-nocheck
import kw from './kw'
import kg from './kg'
import tx from './tx'
import wy from './wy'
import mg from './mg'
import { decodeName, formatPlayCount, formatPlayTime, sizeFormate, dateFormat } from './index'

export { decodeName, formatPlayCount, formatPlayTime, sizeFormate, dateFormat }
export { kw, kg, tx, wy, mg }

export type PlatformId = 'kw' | 'kg' | 'tx' | 'wy' | 'mg'

export const sources: Array<{ id: PlatformId; name: string }> = [
  { id: 'kw', name: '酷我音乐' },
  { id: 'kg', name: '酷狗音乐' },
  { id: 'tx', name: 'QQ音乐' },
  { id: 'wy', name: '网易音乐' },
  { id: 'mg', name: '咪咕音乐' },
]

export const platforms: Record<PlatformId, any> = { kw, kg, tx, wy, mg }

export function isPlatform(id: unknown): id is PlatformId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(platforms, id)
}

export function getPlatform(id: unknown): any {
  return isPlatform(id) ? platforms[id] : null
}

/**
 * 平台方法有两种返回风格：直接 Promise，或 lxserver 的 `{promise, cancelHttp}`
 * 请求对象。统一 settle 成值。
 */
async function settle<T = any>(value: any): Promise<T> {
  if (value && typeof value === 'object' && typeof value.promise?.then === 'function') {
    return await value.promise
  }
  return await value
}

/**
 * 归一化平台返回的歌曲字段（任务坑 3）：
 * 兼容首字母大写字段，并把 musicId/songmid 互为 fallback。
 */
export function normalizeSongInfo(raw: any, platform?: string): any {
  if (!raw || typeof raw !== 'object') return raw
  const get = (lower: string, upper?: string) => {
    const v = raw[lower]
    if (v !== undefined && v !== null && v !== '') return v
    const u = upper || (lower.charAt(0).toUpperCase() + lower.slice(1))
    return raw[u]
  }
  const musicId = get('musicId') ?? get('songmid') ?? get('hash') ?? get('copyrightId')
  const songmid = get('songmid') ?? get('musicId')
  const name = get('name') ?? get('songName') ?? get('title') ?? ''
  const singer = get('singer') ?? get('artist') ?? ''
  const albumName = get('albumName') ?? get('album') ?? ''
  const interval = get('interval') ?? (get('duration') ? formatPlayTime(Number(get('duration'))) : '')
  return {
    ...raw,
    name,
    singer,
    albumName,
    interval,
    songmid,
    musicId,
    source: get('source') ?? platform,
  }
}

/** 平台单曲搜索（主程序契约 / 内部路由共用）。 */
export async function search(platform: PlatformId, keyword: string, page = 1, limit?: number): Promise<any[]> {
  const p = getPlatform(platform)
  if (!p || !p.musicSearch) throw new Error(`unsupported platform: ${platform}`)
  const result = await p.musicSearch.search(keyword, page, limit)
  const list = Array.isArray(result) ? result : (result?.list || [])
  return list.map((item) => normalizeSongInfo(item, platform))
}

/** 统一歌词返回：{ lyric, tlyric }。 */
export async function getLyric(platform: PlatformId, songInfo: any): Promise<{ lyric: string; tlyric: string }> {
  const p = getPlatform(platform)
  if (!p || !p.getLyric) throw new Error(`platform ${platform} has no lyric capability`)
  const info = await settle(p.getLyric(normalizeSongInfo(songInfo, platform)))
  return {
    lyric: typeof info === 'string' ? info : (info?.lyric || info?.lrc || ''),
    tlyric: typeof info === 'string' ? '' : (info?.tlyric || info?.tlrc || ''),
  }
}

/** 歌单标签（结构因平台而异，统一为 {tags, hotTag, source}）。 */
export async function getSongListTags(platform: PlatformId): Promise<any> {
  const p = getPlatform(platform)
  const sl = p?.songList
  if (!sl) throw new Error(`platform ${platform} has no songlist capability`)
  if (typeof sl.getTags === 'function') return await settle(sl.getTags())
  if (typeof sl.getTag === 'function') return { tags: await sl.getTag(), hotTag: [], source: platform }
  return { tags: [], hotTag: [], source: platform }
}

/** 歌单排序选项。 */
export function getSongListSorts(platform: PlatformId): any[] {
  const sl = getPlatform(platform)?.songList
  return Array.isArray(sl?.sortList) ? sl.sortList : []
}

/** 歌单列表。 */
export async function getSongList(platform: PlatformId, sortId: string, tagId: string, page = 1): Promise<any> {
  const sl = getPlatform(platform)?.songList
  if (!sl) throw new Error(`platform ${platform} has no songlist capability`)
  if (typeof sl.getSongList === 'function') return await sl.getSongList(sortId, tagId, page)
  if (typeof sl.getList === 'function') return await sl.getList(sortId, tagId, page)
  throw new Error(`platform ${platform} songlist.list unavailable`)
}

/** 歌单详情。 */
export async function getSongListDetail(platform: PlatformId, id: string, page = 1): Promise<any> {
  const sl = getPlatform(platform)?.songList
  if (!sl) throw new Error(`platform ${platform} has no songlist capability`)
  const result = await settle(sl.getListDetail(id, page))
  // 部分平台返回 {list,total,...}，部分平台直接返回数组
  if (Array.isArray(result)) return { list: result, total: result.length, page, source: platform }
  return result
}

/** 搜索歌单（kw/kg 不支持）。 */
export async function searchSongList(platform: PlatformId, keyword: string, page = 1, limit = 20): Promise<any> {
  const sl = getPlatform(platform)?.songList
  if (!sl || typeof sl.search !== 'function') throw new Error(`platform ${platform} 不支持歌单搜索`)
  return await settle(sl.search(keyword, page, limit))
}

/** 排行榜列表。 */
export async function getLeaderboards(platform: PlatformId): Promise<any[]> {
  const lb = getPlatform(platform)?.leaderboard
  if (!lb) throw new Error(`platform ${platform} has no leaderboard capability`)
  const raw = await settle(lb.getBoards())
  if (Array.isArray(raw)) return raw
  return Array.isArray(raw?.list) ? raw.list : (Array.isArray(raw?.boards) ? raw.boards : [])
}

/** 排行榜歌曲。 */
export async function getLeaderboardList(platform: PlatformId, bangid: string, page = 1): Promise<any> {
  const lb = getPlatform(platform)?.leaderboard
  if (!lb) throw new Error(`platform ${platform} has no leaderboard capability`)
  const result = await settle(lb.getList(bangid, page))
  if (Array.isArray(result)) return { list: result, total: result.length, page, source: platform }
  return result
}

/** 热搜。 */
export async function getHotSearch(platform: PlatformId): Promise<any> {
  const p = getPlatform(platform)
  if (!p?.hotSearch) return []
  return await settle(p.hotSearch.getList())
}

/** 搜索联想。 */
export async function getTipSearch(platform: PlatformId, keyword: string): Promise<any[]> {
  const p = getPlatform(platform)
  if (!p?.tipSearch) return []
  return await settle(p.tipSearch.tipSearchBySong(keyword))
}
