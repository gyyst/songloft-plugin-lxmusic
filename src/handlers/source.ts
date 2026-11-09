/** 音源管理路由：列表、导入（文件/URL/ZIP）、启停、删除。 */
import { parseQuery, type HTTPRequest, type Router } from '@songloft/plugin-sdk'
import { sources as sdkSources } from '../musicSdk/facade'
import type { SourceCandidate } from '../source/types'
import { bodyToBytes, decodeBytesBestEffort, looksLikeZip, multipartBoundary, parseJsonBody, parseMultipart } from '../utils/text'
import { isSourceScriptEntry, unzip } from '../utils/zip'
import type { AppContext } from './shared'
import { qualityOptions } from './shared'
import { fail, ok, okWithWarning } from './response'

function getHeader(req: HTTPRequest, name: string): string {
  const target = name.toLowerCase()
  for (const key of Object.keys(req.headers || {})) {
    if (key.toLowerCase() === target) return req.headers[key]
  }
  return ''
}

function partText(data: Uint8Array): string {
  return decodeBytesBestEffort(data).trim()
}

function candidatesFromZip(name: string, data: Uint8Array, warnings: string[]): SourceCandidate[] {
  const out: SourceCandidate[] = []
  let entries
  try {
    entries = unzip(data).filter((entry) => isSourceScriptEntry(entry.name))
  } catch (err) {
    warnings.push(`${name}: ZIP 解析失败 ${(err as Error)?.message || err}`)
    return out
  }
  if (!entries.length) {
    warnings.push(`${name}: ZIP 中没有找到 .js 音源脚本`)
    return out
  }
  for (const entry of entries) {
    const base = entry.name.replace(/\\/g, '/').split('/').pop() || 'source.js'
    out.push({ script: decodeBytesBestEffort(entry.data), fileName: base })
  }
  return out
}

async function importCandidates(
  ctx: AppContext,
  candidates: SourceCandidate[],
  enable: boolean,
  warnings: string[],
) {
  if (!candidates.length) {
    const message = warnings.length ? warnings.join('；') : '没有找到可导入的音源脚本'
    return fail(message, 400)
  }

  // 单个脚本同步加载，失败时返回 warning；多个脚本走后台队列，立即返回。
  if (candidates.length === 1) {
    const candidate = candidates[0]
    try {
      const result = await ctx.sources.importScript(candidate.script, candidate.fileName, { enable })
      const data = {
        imported: [result.meta],
        batch: false,
        loading: false,
      }
      if (result.warning) {
        warnings.push(result.warning)
      }
      if (warnings.length) return okWithWarning(data, warnings.join('；'))
      return ok(data)
    } catch (err) {
      warnings.push(`${candidate.fileName}: ${(err as Error)?.message || err}`)
      return fail(warnings.join('；'), 400)
    }
  }

  const result = await ctx.sources.importBatch(candidates, { enable })
  warnings.push(...result.warnings)
  const data = {
    imported: result.imported.map((item) => item.meta),
    batch: true,
    loading: true,
    pending: result.imported.length,
  }
  if (warnings.length) return okWithWarning(data, warnings.join('；'))
  return ok(data)
}

async function parseImportRequest(req: HTTPRequest, warnings: string[]): Promise<{ candidates: SourceCandidate[]; enable: boolean }> {
  const contentType = getHeader(req, 'content-type')
  const candidates: SourceCandidate[] = []
  let enable = true

  if (contentType.toLowerCase().includes('multipart/form-data')) {
    const boundary = multipartBoundary(contentType)
    if (!boundary) throw new Error('multipart 请求缺少 boundary')
    const parts = parseMultipart(bodyToBytes(req.body), boundary)
    for (const part of parts) {
      if (part.name === 'enable') {
        const value = partText(part.data).toLowerCase()
        if (value === 'false' || value === '0' || value === 'off') enable = false
        continue
      }
      if (!part.fileName && part.name !== 'file') continue
      const fileName = part.fileName || 'source.js'
      if (/\.zip$/i.test(fileName) || looksLikeZip(part.data)) {
        candidates.push(...candidatesFromZip(fileName, part.data, warnings))
      } else if (/\.js$/i.test(fileName) || !/\.\w+$/.test(fileName)) {
        candidates.push({ script: decodeBytesBestEffort(part.data), fileName })
      } else {
        warnings.push(`${fileName}: 仅支持 .js 或 .zip`)
      }
    }
    return { candidates, enable }
  }

  const body = parseJsonBody(req.body)
  if (body.enable === false) enable = false
  if (typeof body.script === 'string' && body.script.trim()) {
    candidates.push({ script: body.script, fileName: String(body.fileName || body.file_name || 'source.js') })
  } else if (typeof body.url === 'string' && body.url.trim()) {
    const { candidates: fetched, enable: fetchedEnable } = await fetchScriptFromUrl(body.url, warnings)
    return { candidates: fetched, enable: body.enable === false ? false : fetchedEnable }
  }
  return { candidates, enable }
}

async function fetchScriptFromUrl(url: string, warnings: string[]): Promise<{ candidates: SourceCandidate[]; enable: boolean }> {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) throw new Error('仅支持 http/https URL')
  if (target.length > 4096) throw new Error('URL 过长')
  const response = await fetch(target, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
    },
  })
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  const arrayBuffer = await response.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)
  if (bytes.length > 32 * 1024 * 1024) throw new Error('文件过大（上限 32MB）')
  let fileName = 'source.js'
  try {
    const path = new URL(target).pathname
    fileName = decodeURIComponent(path.split('/').pop() || 'source.js') || 'source.js'
  } catch {
    // 保留默认文件名
  }
  if (looksLikeZip(bytes) || /\.zip$/i.test(target)) {
    return { candidates: candidatesFromZip(fileName, bytes, warnings), enable: true }
  }
  return {
    candidates: [{ script: decodeBytesBestEffort(bytes), fileName: /\.js$/i.test(fileName) ? fileName : 'source.js' }],
    enable: true,
  }
}

export function registerSourceRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/sources', () => {
    const snapshot = ctx.sources.snapshot()
    return ok({
      ...snapshot,
      platforms: sdkSources,
      qualities: qualityOptions(),
    })
  })

  router.post('/api/sources/import', async (req) => {
    const warnings: string[] = []
    try {
      const { candidates, enable } = await parseImportRequest(req, warnings)
      return await importCandidates(ctx, candidates, enable, warnings)
    } catch (err) {
      warnings.push((err as Error)?.message || String(err))
      return fail(warnings.join('；'), 400)
    }
  })

  router.post('/api/sources/import-url', async (req) => {
    const warnings: string[] = []
    try {
      const body = parseJsonBody(req.body)
      const url = String(body.url || '').trim()
      if (!url) return fail('url 不能为空')
      const { candidates } = await fetchScriptFromUrl(url, warnings)
      return await importCandidates(ctx, candidates, body.enable !== false, warnings)
    } catch (err) {
      warnings.push((err as Error)?.message || String(err))
      return fail(warnings.join('；'), 400)
    }
  })

  router.delete('/api/sources', async (req) => {
    const query = parseQuery(req.query)
    const id = String(query.id || '').trim()
    if (!id) return fail('缺少 id')
    const deleted = await ctx.sources.deleteSource(id)
    if (!deleted) return fail('音源不存在', 404)
    return ok({ id, deleted: true })
  })

  router.put('/api/sources/toggle', async (req) => {
    try {
      const body = parseJsonBody(req.body)
      const id = String(body.id || '').trim()
      if (!id) return fail('缺少 id')
      const enabled = body.enabled !== false
      const result = await ctx.sources.toggleSource(id, enabled)
      if (!result.ok) return fail(result.error || '操作失败', 400)
      return ok({ id, enabled })
    } catch (err) {
      return fail((err as Error)?.message || String(err), 500)
    }
  })
}
