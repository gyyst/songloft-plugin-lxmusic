/** 排行榜路由。 */
import { parseQuery, type Router } from '@songloft/plugin-sdk'
import { getLeaderboardList, getLeaderboards, isPlatform, type PlatformId } from '../musicSdk/facade'
import type { AppContext } from './shared'
import { extractList, qualityOrDefault, toSongItem } from './shared'
import { fail, ok } from './response'

function firstPlatform(ctx: AppContext, query: Record<string, string>): PlatformId | null {
  const direct = String(query.platform || '').trim().toLowerCase()
  if (isPlatform(direct)) return direct
  const sourceId = String(query.source_id || '').trim()
  if (sourceId) {
    const found = ctx.sources.resolvePlatforms(sourceId).find(isPlatform)
    if (found) return found
  }
  return null
}

function normalizeBoards(platform: string, raw: any[]): any[] {
  return raw.map((board) => {
    const rawId = String(board?.id ?? board?.bangid ?? '')
    const bangid = String(board?.bangid ?? (rawId.includes('__') ? rawId.split('__').pop() : rawId))
    return {
      id: rawId,
      bangid,
      name: String(board?.name || board?.title || '未命名榜单'),
      source: platform,
    }
  })
}

export function registerLeaderboardRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/leaderboard/boards', async (req) => {
    const query = parseQuery(req.query)
    const platform = firstPlatform(ctx, query)
    if (!platform) return fail('platform 参数无效')
    try {
      const boards = await getLeaderboards(platform)
      return ok({ platform, boards: normalizeBoards(platform, boards) })
    } catch (err) {
      return fail((err as Error)?.message || String(err), 500)
    }
  })

  router.get('/api/leaderboard/list', async (req) => {
    const query = parseQuery(req.query)
    const platform = firstPlatform(ctx, query)
    if (!platform) return fail('platform 参数无效')
    const rawBoardId = String(query.board_id || query.bangid || query.id || '').trim()
    if (!rawBoardId) return fail('缺少 board_id')
    const boardId = rawBoardId.includes('__') ? rawBoardId.split('__').pop() || rawBoardId : rawBoardId
    const page = Math.max(1, Math.floor(Number(query.page) || 1))
    const quality = qualityOrDefault(query.quality)
    try {
      const raw = await getLeaderboardList(platform, boardId, page)
      const { list, total } = extractList(raw)
      return ok({
        platform,
        board_id: rawBoardId,
        bangid: boardId,
        page,
        quality,
        total,
        list: list.map((song) => toSongItem(song, platform, quality)),
      })
    } catch (err) {
      return fail((err as Error)?.message || String(err), 500)
    }
  })
}
