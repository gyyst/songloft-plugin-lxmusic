/** 音源脚本 JSDoc 元数据解析与 id 生成。 */

export interface ParsedSourceMeta {
  name: string
  version: string
  description: string
  author: string
  homepage: string
}

/** 从脚本头部 JSDoc 中提取洛雪音源的标准元数据。 */
export function parseScriptMeta(script: string, fallbackName?: string): ParsedSourceMeta {
  const header = script.slice(0, Math.min(script.length, 16384))
  const tags: Record<string, string> = {}
  const re = /@([A-Za-z][\w-]*)[ \t]+([^\r\n]*)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(header))) {
    const key = match[1].toLowerCase()
    if (tags[key] !== undefined) continue
    let value = match[2].trim()
    // 去掉 JSDoc 行尾的 */
    value = value.replace(/\*\/\s*$/, '').trim()
    if (value) tags[key] = value
  }
  const clean = (value: string | undefined, fallback = ''): string => {
    const v = String(value || '').trim()
    return v || fallback
  }
  const name = clean(tags.name, clean(fallbackName, '未命名音源'))
  return {
    name: name.slice(0, 120),
    version: clean(tags.version, '0.0.0').slice(0, 40),
    description: clean(tags.description).slice(0, 500),
    author: clean(tags.author).slice(0, 120),
    homepage: clean(tags.homepage).slice(0, 500),
  }
}

/**
 * 生成音源 id：保留中文与 ASCII 字母数字，其余转 '-'。
 * 结果不含 / \ ..，可直接作为 storage key 的一部分。
 */
export function slugifyName(name: string): string {
  const input = String(name || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) || 0
    const isDigit = code >= 0x30 && code <= 0x39
    const isLower = code >= 0x61 && code <= 0x7a
    const isUpper = code >= 0x41 && code <= 0x5a
    if (isDigit || isLower || isUpper || ch === '_' || ch === '-') out += ch
    else if (code > 0x7f) out += ch
    else out += '-'
  }
  out = out.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return (out || 'source').slice(0, 80)
}

/** 生成不冲突的 id：base、base_2、base_3…… */
export function uniqueId(base: string, used: Set<string>): string {
  let id = base
  let n = 1
  while (used.has(id)) {
    n++
    id = base + '_' + n
  }
  return id
}

/** 从文件名推断音源名（去扩展名）。 */
export function nameFromFileName(fileName: string): string {
  const base = String(fileName || '').split(/[\\/]/).pop() || ''
  return base.replace(/\.(js|zip)$/i, '').trim() || '未命名音源'
}
