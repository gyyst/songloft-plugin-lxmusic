/** 路由总装。 */
import { createRouter, type Router } from '@songloft/plugin-sdk'
import { sources as sdkSources } from '../musicSdk/facade'
import { DEFAULT_QUALITY, ENTRY_PATH } from '../constants'
import type { AppContext } from './shared'
import { qualityOptions } from './shared'
import { ok } from './response'
import { registerSearchRoutes } from './search'
import { registerSourceRoutes } from './source'
import { registerSongListRoutes } from './songlist'
import { registerLeaderboardRoutes } from './leaderboard'

export function createAppRouter(ctx: AppContext): Router {
  const router = createRouter()

  // 前端启动时读取的基础信息。
  router.get('/api/meta', () => {
    return ok({
      entry_path: ENTRY_PATH,
      platforms: sdkSources,
      qualities: qualityOptions(),
      default_quality: DEFAULT_QUALITY,
    })
  })

  registerSearchRoutes(router, ctx)
  registerSourceRoutes(router, ctx)
  registerSongListRoutes(router, ctx)
  registerLeaderboardRoutes(router, ctx)

  return router
}

export type { AppContext }
export { ok, fail } from './response'
