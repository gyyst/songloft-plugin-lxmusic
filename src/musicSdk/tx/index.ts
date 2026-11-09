// @ts-nocheck
import leaderboard from './leaderboard'
import lyric from './lyric'
import songList from './songList'
import musicSearch from './musicSearch'
import hotSearch from './hotSearch'
import tipSearch from './tipSearch'

/**
 * QQ 音乐。仅提供元数据能力，播放直链由引擎侧自定义音源脚本解析。
 */
const tx = {
  tipSearch,
  leaderboard,
  songList,
  musicSearch,
  hotSearch,
  getLyric(songInfo) {
    return lyric.getLyric(songInfo)
  },
  getPic(songInfo) {
    return songInfo.img || `https://y.gtimg.cn/music/photo_new/T002R800x800M000${songInfo.albumId}.jpg`
  },
  getMusicDetailPageUrl(songInfo) {
    return `https://y.qq.com/n/yqq/song/${songInfo.songmid}.html`
  },
}

export default tx
