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
const RANDOM_PLAYLIST_PATH = '/api/songlist/random'
const REGISTER_TIMEOUT_MS = 3000
const RETRY_INTERVAL_MS = 60_000
/**
 * 已注册后仍要周期性重报：mi-song-harness 升级/重装后会读回持久化的旧记录，
 * 只在首次成功后停发，会让后来新增的能力字段（如 playlistPath）永久缺失。
 */
const REFRESH_INTERVAL_MS = 5 * 60_000

let registered = false
let lastAttemptAt = 0
let inflight: Promise<boolean> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null

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
      { name: '洛雪音源', searchPath: SEARCH_PATH, playlistPath: RANDOM_PLAYLIST_PATH, icon: 'music_note' },
      REGISTER_TIMEOUT_MS,
    )) as { ok?: boolean; error?: string } | null
    if (result && result.ok === false) {
      songloft.log.warn('注册到 mi-song-harness 失败: ' + String(result.error || '未知错误'))
      registered = false
      return false
    }
    registered = true
    songloft.log.info('已注册为 mi-song-harness 外部搜索源：' + SEARCH_PATH + '（随机歌单 ' + RANDOM_PLAYLIST_PATH + '）')
    return true
  } catch (err) {
    // 未安装/未启用 mi-song-harness 时是常态，不刷 warn。
    registered = false
    songloft.log.info('暂未注册到 mi-song-harness（未安装或未启用）: ' + errorMessage(err))
    return false
  }
}

/**
 * 确保已注册为 mi-song-harness 的搜索源候选。
 * 未注册时按 60s 重试；已注册后按 5 分钟重报一次，让宿主更新后的新字段
 * 能覆盖旧记录。force=true 跳过节流（定时刷新使用）。
 */
export function ensureMiSongHarnessRegistration(force = false): Promise<boolean> {
  if (inflight) return inflight
  const now = Date.now()
  const interval = registered ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS
  if (!force && now - lastAttemptAt < interval) return Promise.resolve(registered)
  lastAttemptAt = now
  const task = register()
  inflight = task
  const clear = () => {
    inflight = null
  }
  task.then(clear, clear)
  return task
}

/** 周期性重报注册信息；插件停用或休眠时不再产生定时器。 */
export function startMiSongHarnessRegistrationRefresh(): void {
  if (refreshTimer !== null) return
  const schedule = () => {
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void ensureMiSongHarnessRegistration(true)
      schedule()
    }, REFRESH_INTERVAL_MS)
  }
  schedule()
}

export function stopMiSongHarnessRegistrationRefresh(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}
