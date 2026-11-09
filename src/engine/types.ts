/** 洛雪音源引擎的类型定义。 */

/** 音源脚本声明的单个平台能力。 */
export interface SourceCapability {
  /** 能力类型，洛雪音源固定为 music。 */
  type: string
  /** 支持的动作，本插件只使用 musicUrl。 */
  actions: string[]
  /** 支持的音质列表。 */
  qualitys: string[]
}

/** 平台 id → 能力。 */
export type SourceCapabilities = Record<string, SourceCapability>

/** 创建一个 SourceRuntime 所需的元数据。 */
export interface RuntimeSourceMeta {
  id: string
  name: string
  version: string
  description: string
  author: string
  homepage: string
  script: string
}

export type RuntimeStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 音源统计。 */
export interface RuntimeStats {
  totalCalls: number
  successCalls: number
  failedCalls: number
  lastSuccessAt: number
  lastErrorAt: number
  lastError: string
}

/** 一次播放链接解析的结果。 */
export interface ResolvedSourceUrl {
  url: string
  headers?: Record<string, string>
  /** 实际使用的音质（可能因源不支持请求音质而降级）。 */
  quality: string
  sourceId: string
  sourceName: string
}

/** 音源脚本可能使用的音质，按从高到低排列。 */
export const QUALITY_ORDER = ['flac24bit', 'flac', '320k', '128k'] as const

export type MusicQuality = (typeof QUALITY_ORDER)[number]

export function isMusicQuality(value: unknown): value is MusicQuality {
  return typeof value === 'string' && (QUALITY_ORDER as readonly string[]).includes(value)
}

/** 归一化错误信息。 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
