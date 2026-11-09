// @ts-nocheck
import { httpFetch } from '../request'
import tipSearch from './tipSearch'
import musicSearch from './musicSearch'
import { formatSinger, formatPic } from './util'
import leaderboard from './leaderboard'
import lyric from './lyric'
import songList from './songList'
import hotSearch from './hotSearch'

/**
 * 酷我音乐。仅提供元数据能力，播放直链由引擎侧自定义音源脚本解析。
 */
const kw = {
  tipSearch,
  musicSearch,
  leaderboard,
  songList,
  hotSearch,
  getLyric(songInfo, isGetLyricx) {
    return lyric.getLyric(songInfo, isGetLyricx)
  },
  handleMusicInfo(songInfo) {
    return this.getMusicInfo(songInfo).then((info) => {
      songInfo.name = info.name
      songInfo.singer = formatSinger(info.artist)
      songInfo.img = formatPic(info.pic)
      songInfo.albumName = info.album
      return songInfo
    })
  },
  getMusicInfo(songInfo) {
    const requestObj = httpFetch(`http://www.kuwo.cn/api/www/music/musicInfo?mid=${songInfo.songmid}`)
    return requestObj.promise.then(({ body }) => {
      return body.code === 200 ? body.data : Promise.reject(new Error(body.msg))
    })
  },
  getPic(songInfo) {
    return songInfo.img || ''
  },
  getMusicDetailPageUrl(songInfo) {
    return `http://www.kuwo.cn/play_detail/${songInfo.songmid}`
  },
}

export default kw
