// @ts-nocheck
import leaderboard from './leaderboard'
import songList from './songList'
import musicSearch from './musicSearch'
import lyric from './lyric'
import hotSearch from './hotSearch'
import tipSearch from './tipSearch'

/**
 * 咪咕音乐。仅提供元数据能力，播放直链由引擎侧自定义音源脚本解析。
 */
const mg = {
  tipSearch,
  songList,
  musicSearch,
  leaderboard,
  hotSearch,
  getLyric(songInfo) {
    return lyric.getLyric(songInfo)
  },
  getPic(songInfo) {
    return songInfo.img || ''
  },
  getMusicDetailPageUrl(songInfo) {
    return `http://music.migu.cn/v3/music/song/${songInfo.copyrightId}`
  },
}

export default mg
