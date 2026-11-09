/** 热搜路由。 */
import { parseQuery, type Router } from '@songloft/plugin-sdk'
import { getHotSearch, isPlatform } from '../musicSdk/facade'
import { fail, ok } from './response'

/** 各平台热搜返回结构不完全一致，统一成字符串数组。 */
function normalizeHotList(raw: any): string[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : []
  const out: string[] = []
  for (const item of list) {
    const text =
      typeof item === 'string'
        ? item
        : String(item?.word ?? item?.name ?? item?.key ?? item?.query ?? '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out.slice(0, 30)
}

export function registerHotRoutes(router: Router): void {
  router.get('/api/hot', async (req) => {
    const query = parseQuery(req.query)
    const platform = String(query.platform || query.source || query.source_id || 'wy').trim().toLowerCase()
    if (!isPlatform(platform)) return fail('platform 参数无效')
    try {
      const raw = await getHotSearch(platform)
      return ok({ platform, list: normalizeHotList(raw) })
    } catch (err) {
      return fail((err as Error)?.message || String(err), 500)
    }
  })
}
