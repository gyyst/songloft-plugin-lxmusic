// @ts-nocheck
import leaderboard from './leaderboard'
import songList from './songList'
import musicSearch from './musicSearch'
import lyric from './lyric'
import hotSearch from './hotSearch'
import tipSearch from './tipSearch'

/**
 * 酷狗音乐。仅提供元数据能力（搜索/歌词/歌单/榜单），
 * 播放直链由引擎侧自定义音源脚本解析。
 */
const kg = {
  tipSearch,
  leaderboard,
  songList,
  musicSearch,
  hotSearch,
  getLyric(songInfo) {
    return lyric.getLyric(songInfo)
  },
  getPic(songInfo) {
    return songInfo.img || ''
  },
  getMusicDetailPageUrl(songInfo) {
    return `https://www.kugou.com/song/#hash=${songInfo.hash}&album_id=${songInfo.albumId}`
  },
}

export default kg
