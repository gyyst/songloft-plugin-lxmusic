import './setup'
import { jsonResponse, type HTTPRequest, type HTTPResponse, type Router } from '@songloft/plugin-sdk'
import { RuntimeManager } from './engine'
import { SourceManager } from './source/manager'
import { createAppRouter } from './handlers'
import { ensureMiSongHarnessRegistration } from './integrations/miSongHarness'
import type { AppContext } from './handlers/shared'

let ctx: AppContext | null = null
let router: Router | null = null
let initPromise: Promise<AppContext> | null = null

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

async function doInit(): Promise<AppContext> {
  if (ctx) return ctx
  const runtimes = new RuntimeManager()
  const sources = new SourceManager(runtimes)
  const context: AppContext = { sources, runtimes }
  ctx = context
  // 先建立路由，保证音源索引读取失败时 UI 仍可打开并重新导入。
  router = createAppRouter(context)
  await sources.init()
  return context
}

async function ensureInit(): Promise<AppContext> {
  if (ctx) return ctx
  if (!initPromise) {
    initPromise = doInit().catch((err) => {
      initPromise = null
      throw err
    })
  }
  return await initPromise
}

async function onInit(): Promise<void> {
  try {
    await ensureInit()
    songloft.log.info('洛雪音源插件已初始化')
    // 异步注册为 mi-song-harness 的外部搜索源候选；未安装时静默失败，不阻塞初始化。
    void ensureMiSongHarnessRegistration()
  } catch (err) {
    songloft.log.error('洛雪音源插件初始化失败: ' + errorMessage(err))
  }
}

async function onDeinit(): Promise<void> {
  try {
    if (ctx) await ctx.sources.dispose()
  } catch (err) {
    songloft.log.warn('释放音源失败: ' + errorMessage(err))
  }
  ctx = null
  router = null
  initPromise = null
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  try {
    await ensureInit()
    // 若 mi-song-harness 在本插件之后才安装/启用，打开插件页面时补一次注册（内部 60s 节流）。
    void ensureMiSongHarnessRegistration()
    if (!router) throw new Error('路由尚未就绪')
    return await router.handle(req)
  } catch (err) {
    const message = errorMessage(err)
    songloft.log.error(`处理请求失败 ${req.method} ${req.path}: ${message}`)
    // 主程序契约端点返回 {error}，内部 UI 端点返回统一的 {code,msg,data}。
    const isContract = req.path === '/api/search' || req.path === '/api/music/url'
    if (isContract) return jsonResponse({ error: message }, 500)
    return jsonResponse({ code: 500, msg: message, data: null }, 500)
  }
}

// QuickJS 需要显式挂到 globalThis。
globalThis.onInit = onInit
globalThis.onDeinit = onDeinit
globalThis.onHTTPRequest = onHTTPRequest
