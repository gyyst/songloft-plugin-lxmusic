/**
 * musicSdk 平台间共享工具（移植自 lxserver `modules/utils/musicSdk/utils.js`）。
 */
import { decodeName } from './index'
import { toMD5 } from './crypto-shim'

export { decodeName, toMD5 }

/**
 * 格式化歌手
 * @param singers 歌手数组
 * @param nameKey 歌手名键值
 * @param join 歌手分割字符
 */
export const formatSingerName = (singers: any, nameKey = 'name', join = '、'): string => {
  if (Array.isArray(singers)) {
    const singer: string[] = []
    singers.forEach((item) => {
      const name = item?.[nameKey]
      if (!name) return
      singer.push(name)
    })
    return decodeName(singer.join(join))
  }
  return decodeName(String(singers ?? ''))
}
