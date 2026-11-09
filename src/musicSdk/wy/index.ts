// @ts-nocheck
import leaderboard from './leaderboard'
import getLyric from './lyric'
import getMusicInfo from './musicInfo'
import musicSearch from './musicSearch'
import songList from './songList'
import hotSearch from './hotSearch'
import tipSearch from './tipSearch'

/**
 * 网易云音乐。仅提供元数据能力，播放直链由引擎侧自定义音源脚本解析。
 */
const wy = {
  tipSearch,
  leaderboard,
  musicSearch,
  songList,
  hotSearch,
  getLyric(songInfo) {
    return getLyric(songInfo.songmid)
  },
  getPic(songInfo) {
    if (songInfo.img) return songInfo.img
    const requestObj = getMusicInfo(songInfo.songmid)
    return requestObj.promise.then((info) => info.al.picUrl)
  },
  getMusicDetailPageUrl(songInfo) {
    return `https://music.163.com/#/song?id=${songInfo.songmid}`
  },
}

export default wy
