/**
 * 与 mi-song-harness（小爱音箱插件）的对接。
 *
 * mi-song-harness 在本地曲库未命中时，会调用用户启用的外部搜索源
 * （约定 POST /api/search/topone）。这里把本插件注册为它的搜索源候选，
 * 用户在 mi-song-harness 设置页「外部搜索」里快速选择「洛雪音源」即可启用。
 *
 * 注册是幂等的：entryPath 由宿主在 comm 调用时以可信 from 注入，payload 无法伪造。
 * 目标插件未安装/未启用时 call 会失败，属正常情况，不影响本插件其他功能。
 */

const TARGET_ENTRY_PATH = 'mi-song-harness'
const SEARCH_PATH = '/api/search/topone'
const REGISTER_TIMEOUT_MS = 3000
const RETRY_INTERVAL_MS = 60_000

let registered = false
let lastAttemptAt = 0
let inflight: Promise<boolean> | null = null

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export function isMiSongHarnessRegistered(): boolean {
  return registered
}

async function register(): Promise<boolean> {
  try {
    const result = (await songloft.comm.call(
      TARGET_ENTRY_PATH,
      'register-search-provider',
      { name: '洛雪音源', searchPath: SEARCH_PATH, icon: 'music_note' },
      REGISTER_TIMEOUT_MS,
    )) as { ok?: boolean; error?: string } | null
    if (result && result.ok === false) {
      songloft.log.warn('注册到 mi-song-harness 失败: ' + String(result.error || '未知错误'))
      return false
    }
    registered = true
    songloft.log.info('已注册为 mi-song-harness 外部搜索源：' + SEARCH_PATH)
    return true
  } catch (err) {
    // 未安装/未启用 mi-song-harness 时是常态，不刷 warn。
    songloft.log.info('暂未注册到 mi-song-harness（未安装或未启用）: ' + errorMessage(err))
    return false
  }
}

/**
 * 确保已注册为 mi-song-harness 的搜索源候选。
 * force=false 时按 60s 节流，避免每次 HTTP 请求都触发一次 RPC。
 */
export function ensureMiSongHarnessRegistration(force = false): Promise<boolean> {
  if (registered) return Promise.resolve(true)
  if (inflight) return inflight
  const now = Date.now()
  if (!force && now - lastAttemptAt < RETRY_INTERVAL_MS) return Promise.resolve(false)
  lastAttemptAt = now
  const task = register()
  inflight = task
  const clear = () => {
    inflight = null
  }
  task.then(clear, clear)
  return task
}
