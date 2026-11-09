import type { RuntimeSourceMeta, RuntimeStats, RuntimeStatus, SourceCapabilities } from '../engine/types'

/** 音源平台能力（持久化到索引，供 UI 在未加载时展示）。 */
export interface SourcePlatformInfo {
  platform: string
  type: string
  actions: string[]
  qualitys: string[]
}

/** 持久化的音源元数据。 */
export interface SourceMeta {
  id: string
  name: string
  version: string
  description: string
  author: string
  homepage: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  size: number
  fileName?: string
  platforms: SourcePlatformInfo[]
}

/** 音源运行状态快照。 */
export interface SourceSnapshot extends SourceMeta {
  status: RuntimeStatus
  error: string
  stats: RuntimeStats
}

export interface SourceListSnapshot {
  sources: SourceSnapshot[]
  total: number
  loading: boolean
  batch_current_id: string | null
  batch_pending_ids: string[]
}

export interface ImportResult {
  meta: SourceMeta
  warning?: string
}

export interface SourceCandidate {
  script: string
  fileName: string
}

export interface SourceEntryLike {
  meta: SourceMeta
  runtimeMeta: RuntimeSourceMeta
  capabilities: SourceCapabilities
}
