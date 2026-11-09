/* 洛雪音源插件前端（vanilla JS，由 builder 打包为 app.bundle.js）。 */
(function () {
  'use strict'

  var API = '/api/v1/jsplugin/lxmusic/api'
  var HOST_API = '/api/v1'
  var SEARCH_PAGE_SIZE = 20
  var LOCAL_PAGE_SIZE = 200
  var LS_THEME = 'lxmusic.theme'
  var LS_QUALITY = 'lxmusic.quality'
  var LS_PLAYER = 'lxmusic.player'
  var LS_HOT = 'lxmusic.hot'
  var SVG_NS = 'http://www.w3.org/2000/svg'

  /* ================= 基础工具 ================= */

  function $(selector, root) {
    return (root || document).querySelector(selector)
  }

  function $all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector))
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function svgIcon(name, className) {
    var svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'icon' + (className ? ' ' + className : ''))
    svg.setAttribute('aria-hidden', 'true')
    var use = document.createElementNS(SVG_NS, 'use')
    use.setAttribute('href', '#i-' + name)
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-' + name)
    svg.appendChild(use)
    return svg
  }

  function formatDuration(value) {
    if (typeof value === 'string' && value.indexOf(':') >= 0) return value
    var total = Math.max(0, Math.round(Number(value) || 0))
    if (!total) return '--:--'
    var m = Math.floor(total / 60)
    var s = total % 60
    return m + ':' + (s < 10 ? '0' + s : String(s))
  }

  function formatCount(value) {
    if (value === undefined || value === null || value === '') return ''
    if (typeof value === 'string' && /[万亿]/.test(value)) return value
    var n = Number(value)
    if (!isFinite(n) || n <= 0) return String(value || '')
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿'
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万'
    return String(Math.round(n))
  }

  function fixImageUrl(url) {
    var text = String(url || '').trim()
    if (!text) return ''
    if (text.indexOf('//') === 0) return 'https:' + text
    return text
  }

  function imageUrl(url) {
    var text = fixImageUrl(url)
    if (!text) return ''
    try {
      if (text.charAt(0) === '/' && text.indexOf('//') !== 0) return withToken(text)
      if (text.indexOf('http:') === 0 && window.location.protocol === 'https:') {
        return withToken(HOST_API + '/proxy?url=' + encodeURIComponent(text))
      }
    } catch (err) {
      /* ignore */
    }
    return text
  }

  function parseMaybeJson(value) {
    if (typeof value !== 'string') return value
    var text = value.trim()
    if (!text) return null
    if (text.charAt(0) !== '{' && text.charAt(0) !== '[') return value
    try {
      return JSON.parse(text)
    } catch (err) {
      return value
    }
  }

  function absoluteUrl(url) {
    try {
      return new URL(url, window.location.href).href
    } catch (err) {
      return url
    }
  }

  /* ================= 鉴权 ================= */

  var TOKEN_KEYS = ['songloft-auth', 'songloft_auth', 'songloft:auth', 'access_token', 'accessToken', 'token']

  function tokenFromValue(raw) {
    if (!raw) return ''
    var text = String(raw).trim()
    if (!text) return ''
    if (text.charAt(0) === '{' || text.charAt(0) === '"') {
      try {
        var parsed = JSON.parse(text)
        if (typeof parsed === 'string') return parsed.trim()
        if (parsed && typeof parsed === 'object') {
          var value =
            parsed.accessToken || parsed.access_token || parsed.token ||
            (parsed.state && (parsed.state.accessToken || parsed.state.access_token || parsed.state.token)) ||
            (parsed.auth && (parsed.auth.accessToken || parsed.auth.access_token))
          if (value) return String(value).trim()
        }
      } catch (err) {
        /* 不是 JSON，按原始 token 处理 */
      }
    }
    return text
  }

  function readTokenFromStorage(storage) {
    if (!storage) return ''
    for (var i = 0; i < TOKEN_KEYS.length; i++) {
      var raw = null
      try {
        raw = storage.getItem(TOKEN_KEYS[i])
      } catch (err) {
        raw = null
      }
      var token = tokenFromValue(raw)
      if (token) return token
    }
    return ''
  }

  var cachedToken = ''

  function getToken() {
    var injected = typeof window !== 'undefined' ? window.__SONGLOFT_AUTH__ || window.__songloftAuth__ : null
    if (injected) {
      if (typeof injected === 'object') {
        var value = injected.accessToken || injected.access_token || injected.token
        if (value) return String(value)
      } else {
        var injectedToken = tokenFromValue(injected)
        if (injectedToken) return injectedToken
      }
    }
    if (cachedToken) return cachedToken
    try {
      var params = new URLSearchParams(window.location.search || '')
      var fromQuery = params.get('access_token') || params.get('token')
      if (fromQuery) {
        cachedToken = fromQuery
        return cachedToken
      }
    } catch (err) {
      /* ignore */
    }
    // localStorage 中的 token 可能被宿主刷新，这里不缓存，确保后续请求使用最新值。
    return readTokenFromStorage(window.localStorage) || readTokenFromStorage(window.sessionStorage)
  }

  function withToken(url) {
    var token = getToken()
    if (!token || !url || typeof url !== 'string' || url.charAt(0) !== '/' || url.indexOf('//') === 0) return url
    try {
      var parsed = new URL(url, 'http://songloft.local')
      parsed.searchParams.set('access_token', token)
      return parsed.pathname + parsed.search + parsed.hash
    } catch (err) {
      return url
    }
  }

  /* ================= HTTP ================= */

  function errorMessage(err) {
    if (!err) return '未知错误'
    if (err instanceof Error) return err.message
    if (typeof err === 'string') return err
    try {
      return JSON.stringify(err)
    } catch (e) {
      return String(err)
    }
  }

  async function api(path, options) {
    var opts = options || {}
    var url = path.charAt(0) === '/' ? path : API + '/' + path
    var headers = {}
    var sourceHeaders = opts.headers || {}
    Object.keys(sourceHeaders).forEach(function (key) {
      headers[key] = sourceHeaders[key]
    })
    var isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData
    if (opts.body && !isForm && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
    var token = getToken()
    if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token

    var response
    try {
      response = await fetch(url, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body,
        credentials: 'same-origin',
        cache: 'no-store',
      })
    } catch (err) {
      throw new Error('网络请求失败，请确认插件服务可用：' + errorMessage(err))
    }

    var text = await response.text()
    var payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch (err) {
        payload = text
      }
    }

    if (!response.ok) {
      var message =
        payload && typeof payload === 'object'
          ? payload.msg || payload.error || payload.message
          : typeof payload === 'string'
            ? payload
            : ''
      if (response.status === 401 || response.status === 403) {
        throw new Error((message ? message + '（' : '（') + '请从 Songloft 插件页面打开，或重新登录宿主）')
      }
      throw new Error(message || 'HTTP ' + response.status)
    }

    if (payload && typeof payload === 'object' && typeof payload.code === 'number') {
      if (payload.code !== 0) throw new Error(payload.msg || '请求失败')
      return { data: payload.data, warning: payload.warning || '' }
    }
    return { data: payload, warning: '' }
  }

  async function hostApi(path, options) {
    var opts = options || {}
    var url = path.charAt(0) === '/' ? path : HOST_API + '/' + path
    var headers = { 'Content-Type': 'application/json' }
    var sourceHeaders = opts.headers || {}
    Object.keys(sourceHeaders).forEach(function (key) {
      headers[key] = sourceHeaders[key]
    })
    var token = getToken()
    if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token
    var response = await fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      credentials: 'same-origin',
      cache: 'no-store',
    })
    var text = await response.text()
    var payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch (err) {
        payload = text
      }
    }
    if (!response.ok) {
      var message =
        payload && typeof payload === 'object'
          ? payload.msg || payload.error || payload.message
          : typeof payload === 'string'
            ? payload
            : ''
      if (typeof message === 'string' && /^\s*</.test(message)) message = ''
      var error = new Error(message || 'HTTP ' + response.status)
      error.status = response.status
      throw error
    }
    return payload
  }

  /* ================= 全局状态 ================= */

  var state = {
    meta: null,
    platforms: [],
    platformNames: {},
    qualities: [],
    quality: '320k',
    route: 'search',
    hotLoadedFor: '',
    search: {
      keyword: '',
      platform: '',
      quality: '',
      page: 1,
      songs: [],
      selected: new Set(),
      loading: false,
      hasMore: false,
      seq: 0,
    },
    songlist: {
      platform: 'wy',
      keyword: '',
      tagId: '',
      sortId: '',
      tagsData: null,
      page: 1,
      pageSeq: 0,
      lists: [],
      total: 0,
      loading: false,
      tagsLoaded: false,
      detail: null,
      detailSongs: [],
      detailPage: 1,
      detailHasMore: false,
      detailTotal: 0,
      detailSeq: 0,
    },
    leaderboard: {
      platform: 'wy',
      boards: [],
      activeBoard: null,
      songs: [],
      page: 1,
      hasMore: false,
      total: 0,
      loading: false,
      boardsSeq: 0,
      songsSeq: 0,
    },
    local: {
      view: 'songs',
      songs: [],
      offset: 0,
      total: 0,
      loading: false,
      hasMore: true,
      keyword: '',
      playlists: [],
      playlistsLoaded: false,
      detail: null,
      detailSongs: [],
    },
    sources: {
      items: [],
      requesting: false,
      batchLoading: false,
      batchCurrent: null,
      batchPending: [],
      pollTimer: null,
    },
    update: {
      loaded: false,
      loading: false,
      requesting: false,
      applying: false,
      autoSaving: false,
      pluginId: 0,
      currentVersion: '',
      latestVersion: '',
      hasUpdate: false,
      checked: false,
      autoUpdate: null,
      autoError: '',
      status: '',
      statusKind: '',
    },
    files: [],
  }

  var ROUTE_TITLES = {
    search: '搜索',
    songlist: '歌单',
    leaderboard: '排行榜',
    local: '本地音乐',
    settings: '设置',
  }

  var PLATFORM_SHORT = { kw: '酷我', kg: '酷狗', tx: 'QQ', wy: '网易云', mg: '咪咕' }

  var QUALITY_LABELS = { flac24bit: '母带', flac: '无损', '320k': '高品质', '128k': '标准' }

  function qualityLabel(value) {
    if (value === 'original') return '原曲'
    return QUALITY_LABELS[value] || value || ''
  }

  function platformName(id) {
    return state.platformNames[id] || PLATFORM_SHORT[id] || String(id || '').toUpperCase()
  }

  function platformShort(id) {
    return PLATFORM_SHORT[id] || state.platformNames[id] || String(id || '').toUpperCase()
  }

  function platformTag(song) {
    var tag = el('span', 'tag')
    var platform = song && song.platform
    if (song && song.isLocal) {
      tag.className = 'tag tag-local'
      tag.textContent = '本地'
    } else if (platform && (PLATFORM_SHORT[platform] || state.platformNames[platform])) {
      tag.className = 'tag tag-' + platform
      tag.textContent = platformShort(platform)
    } else {
      tag.className = 'tag tag-default'
      tag.textContent = song && song.id ? '曲库' : '网络'
    }
    return tag
  }

  /* ================= Toast / 弹窗 ================= */

  function toast(message, type) {
    var box = $('#toasts')
    if (!box) return
    var node = el('div', 'toast' + (type ? ' ' + type : ''))
    node.appendChild(el('span', 'toast-msg', message))
    box.appendChild(node)
    var ttl = type === 'error' ? 6000 : 3600
    setTimeout(function () {
      node.classList.add('leaving')
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node)
      }, 220)
    }, ttl)
  }

  var confirmResolver = null

  function askConfirm(title, message, okText) {
    var dialog = $('#confirm-dialog')
    $('#confirm-title').textContent = title || '确认操作'
    $('#confirm-message').textContent = message || ''
    $('#confirm-ok').textContent = okText || '确定'
    if (!dialog) return Promise.resolve(window.confirm(message || title || '确定操作？'))
    if (confirmResolver) {
      var old = confirmResolver
      confirmResolver = null
      old(false)
    }
    return new Promise(function (resolve) {
      confirmResolver = resolve
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal()
      } else {
        dialog.setAttribute('open', '')
      }
    })
  }

  function resolveConfirm(value) {
    if (!confirmResolver) return
    var resolver = confirmResolver
    confirmResolver = null
    var dialog = $('#confirm-dialog')
    if (dialog) {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
    }
    resolver(value)
  }

  /* ================= 主题 / 侧边栏 ================= */

  function isDarkTheme() {
    var attr = document.documentElement.getAttribute('data-theme')
    if (attr === 'dark') return true
    if (attr === 'light') return false
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    } catch (err) {
      return false
    }
  }

  function updateThemeButton() {
    var use = $('#theme-toggle use')
    if (use) use.setAttribute('href', isDarkTheme() ? '#i-sun' : '#i-moon')
    var btn = $('#theme-toggle')
    if (btn) btn.title = isDarkTheme() ? '切换到浅色主题' : '切换到深色主题'
  }

  function initTheme() {
    var saved = ''
    try {
      saved = localStorage.getItem(LS_THEME) || ''
    } catch (err) {
      saved = ''
    }
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved)
    updateThemeButton()
    try {
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeButton)
      }
    } catch (err) {
      /* ignore */
    }
  }

  function toggleTheme() {
    var next = isDarkTheme() ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem(LS_THEME, next)
    } catch (err) {
      /* ignore */
    }
    updateThemeButton()
  }

  function openSidebar() {
    var sidebar = $('#sidebar')
    var backdrop = $('#sidebar-backdrop')
    if (sidebar) sidebar.classList.add('open')
    if (backdrop) backdrop.classList.add('show')
  }

  function closeSidebar() {
    var sidebar = $('#sidebar')
    var backdrop = $('#sidebar-backdrop')
    if (sidebar) sidebar.classList.remove('open')
    if (backdrop) backdrop.classList.remove('show')
  }

  /* ================= 路由 ================= */

  function navigate(route, options) {
    if (!ROUTE_TITLES[route]) route = 'search'
    var opts = options || {}
    state.route = route
    $all('.nav-item').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-route') === route)
    })
    $all('.page-section').forEach(function (section) {
      section.hidden = section.getAttribute('data-page') !== route
    })
    var title = $('#page-title')
    if (title) title.textContent = ROUTE_TITLES[route]
    try {
      history.replaceState(null, '', '#' + route)
    } catch (err) {
      /* ignore */
    }
    closeSidebar()
    if (opts.skipLoad) return
    if (route === 'search') loadHot(false)
    if (route === 'songlist') ensureSonglist()
    if (route === 'leaderboard') ensureLeaderboard()
    if (route === 'local') ensureLocal()
    if (route === 'settings') {
      syncSettingsUI()
      refreshSources(false)
      loadUpdatePanel(false)
    }
  }

  function currentRouteFromHash() {
    var hash = ''
    try {
      hash = String(location.hash || '').replace('#', '')
    } catch (err) {
      hash = ''
    }
    return ROUTE_TITLES[hash] ? hash : 'search'
  }

  /* ================= 元信息 ================= */

  function fillPlatformSelect(select, includeAll, preferred) {
    if (!select) return
    var previous = select.value
    select.innerHTML = ''
    if (includeAll) select.appendChild(new Option('全部平台', ''))
    var ids = []
    state.platforms.forEach(function (platform) {
      select.appendChild(new Option(platform.name, platform.id))
      ids.push(platform.id)
    })
    if (includeAll) {
      if (previous && ids.indexOf(previous) >= 0) select.value = previous
      else select.value = ''
    } else {
      var wanted = previous && ids.indexOf(previous) >= 0 ? previous : preferred || (ids.indexOf('wy') >= 0 ? 'wy' : ids[0]) || ''
      select.value = wanted
    }
  }

  function fillQualitySelect(select, preserve) {
    if (!select) return
    var previous = select.value
    select.innerHTML = ''
    state.qualities.forEach(function (quality) {
      select.appendChild(new Option(qualityLabel(quality) + '（' + quality + '）', quality))
    })
    select.value = preserve && state.qualities.indexOf(previous) >= 0 ? previous : state.quality
  }

  async function loadMeta() {
    var result = await api('meta')
    var meta = result.data || {}
    state.meta = meta
    state.platforms = Array.isArray(meta.platforms) ? meta.platforms : []
    state.platformNames = {}
    state.platforms.forEach(function (platform) {
      state.platformNames[platform.id] = platform.name
    })
    state.qualities = Array.isArray(meta.qualities) && meta.qualities.length ? meta.qualities : ['flac24bit', 'flac', '320k', '128k']
    var savedQuality = ''
    try {
      savedQuality = localStorage.getItem(LS_QUALITY) || ''
    } catch (err) {
      savedQuality = ''
    }
    state.quality = savedQuality || meta.default_quality || '320k'
    if (state.qualities.indexOf(state.quality) < 0) state.quality = state.qualities[0] || '320k'

    fillPlatformSelect($('#search-platform'), true)
    fillPlatformSelect($('#songlist-platform'), false, 'wy')
    fillPlatformSelect($('#leaderboard-platform'), false, 'wy')
    fillQualitySelect($('#search-quality'), true)
    fillQualitySelect($('#default-quality'), false)
    state.songlist.platform = ($('#songlist-platform') && $('#songlist-platform').value) || state.songlist.platform
    state.leaderboard.platform = ($('#leaderboard-platform') && $('#leaderboard-platform').value) || state.leaderboard.platform
    updateSourceBrief()
  }

  /* ================= 歌曲数据归一化 ================= */

  function songKey(song) {
    if (!song) return ''
    var source = parseMaybeJson(song.source_data) || {}
    var info = source.songInfo || {}
    var id =
      info.songmid !== undefined && info.songmid !== null && info.songmid !== ''
        ? info.songmid
        : info.musicId !== undefined && info.musicId !== null && info.musicId !== ''
          ? info.musicId
          : info.music_id !== undefined && info.music_id !== null && info.music_id !== ''
            ? info.music_id
            : info.hash !== undefined && info.hash !== null && info.hash !== ''
              ? info.hash
              : info.copyrightId !== undefined && info.copyrightId !== null && info.copyrightId !== ''
                ? info.copyrightId
                : info.songId !== undefined && info.songId !== null && info.songId !== ''
                  ? info.songId
                  : ''
    if (!id && song.id) return 'host:' + song.id
    return [song.platform || source.platform || '', id || String(song.title || '') + '|' + String(song.artist || '')].join(':')
  }

  function normalizeSearchSong(raw) {
    var source = parseMaybeJson(raw && raw.source_data)
    var platform = (raw && (raw.platform || (source && source.platform))) || ''
    return {
      title: String((raw && raw.title) || (raw && raw.name) || '未知歌曲'),
      artist: String((raw && raw.artist) || ''),
      album: String((raw && raw.album) || ''),
      duration: Number(raw && raw.duration) || 0,
      cover_url: fixImageUrl((raw && raw.cover_url) || ''),
      platform: platform,
      quality: (raw && raw.quality) || (source && source.quality) || state.quality,
      source_data: source || null,
      id: raw && raw.id ? raw.id : null,
      isLocal: false,
      raw: raw,
    }
  }

  function normalizeHostSong(raw) {
    var source = parseMaybeJson(raw && raw.source_data)
    var platform = (source && source.platform) || ''
    return {
      id: raw && raw.id ? raw.id : null,
      title: String((raw && (raw.title || raw.name)) || '未知歌曲'),
      artist: String((raw && (raw.artist || raw.singer)) || ''),
      album: String((raw && raw.album) || ''),
      duration: Number(raw && raw.duration) || 0,
      cover_url: fixImageUrl(raw && raw.cover_url),
      platform: platform,
      quality: (source && source.quality) || state.quality,
      source_data: source || null,
      isLocal: !!(raw && raw.type === 'local'),
      type: raw && raw.type,
      raw: raw,
    }
  }

  function normalizePlaylist(raw, platform) {
    return {
      id: String((raw && (raw.id || raw.listId)) || ''),
      name: String((raw && (raw.name || raw.title)) || '未命名歌单'),
      author: String((raw && (raw.author || raw.creator || raw.nickname)) || ''),
      cover_url: fixImageUrl((raw && (raw.cover_url || raw.img || raw.cover)) || ''),
      play_count: (raw && (raw.play_count || raw.playCount)) || '',
      total: Number(raw && (raw.total || raw.song_count)) || 0,
      description: String((raw && (raw.description || raw.desc)) || ''),
      platform: platform || (raw && raw.source) || '',
    }
  }

  function coverNode(url, className) {
    var box = el('div', className || 'row-cover')
    var src = imageUrl(url)
    if (src) {
      var img = document.createElement('img')
      img.loading = 'lazy'
      img.alt = ''
      img.referrerPolicy = 'no-referrer'
      img.src = src
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.removeChild(img)
        if (!box.querySelector('.icon')) box.appendChild(svgIcon('music'))
      })
      box.appendChild(img)
    } else {
      box.appendChild(svgIcon('music'))
    }
    return box
  }

  function appendCover(container, url) {
    if (!container) return
    container.innerHTML = ''
    var src = imageUrl(url)
    if (src) {
      var img = document.createElement('img')
      img.loading = 'lazy'
      img.alt = ''
      img.referrerPolicy = 'no-referrer'
      img.src = src
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.removeChild(img)
        if (!container.querySelector('.icon')) container.appendChild(svgIcon('music'))
      })
      container.appendChild(img)
    } else {
      container.appendChild(svgIcon('music'))
    }
  }

  /* ================= 通用歌曲列表 ================= */

  function actionButton(icon, title, handler, extraClass) {
    var button = el('button', 'action-btn' + (extraClass ? ' ' + extraClass : ''))
    button.type = 'button'
    button.title = title
    button.setAttribute('aria-label', title)
    button.appendChild(svgIcon(icon))
    button.addEventListener('click', function (event) {
      event.stopPropagation()
      handler()
    })
    return button
  }

  function createSongRow(song, index, options) {
    var opts = options || {}
    var row = el('li', 'song-row')
    row.setAttribute('data-key', songKey(song))
    if (opts.selectedSet && opts.selectedSet.has(songKey(song))) row.classList.add('selected')

    var checkWrap = el('span', 'row-check')
    if (opts.selectable) {
      var checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = !!(opts.selectedSet && opts.selectedSet.has(songKey(song)))
      checkbox.setAttribute('aria-label', '选择 ' + (song.title || '歌曲'))
      checkbox.addEventListener('change', function () {
        if (!opts.selectedSet) return
        if (checkbox.checked) opts.selectedSet.add(songKey(song))
        else opts.selectedSet.delete(songKey(song))
        row.classList.toggle('selected', checkbox.checked)
        if (opts.onSelectionChange) opts.onSelectionChange()
      })
      checkWrap.appendChild(checkbox)
    }
    row.appendChild(checkWrap)

    row.appendChild(el('span', 'row-index', String((opts.indexOffset || 0) + index + 1)))
    row.appendChild(coverNode(song.cover_url))

    var main = el('div', 'row-main')
    var title = el('button', 'row-title', song.title || '未知歌曲')
    title.type = 'button'
    title.title = song.title || ''
    title.addEventListener('click', function (event) {
      event.stopPropagation()
      if (opts.onPlay) opts.onPlay(index)
      else playSongs([song], 0)
    })
    main.appendChild(title)
    main.appendChild(el('div', 'row-sub', [song.artist || '未知歌手', song.album || ''].filter(Boolean).join(' · ')))
    row.appendChild(main)

    row.appendChild(el('span', 'row-album', song.album || '—'))

    var platform = el('span', 'row-platform')
    platform.appendChild(platformTag(song))
    row.appendChild(platform)

    row.appendChild(el('span', 'row-duration', formatDuration(song.duration)))

    var actions = el('div', 'row-actions')
    actions.appendChild(
      actionButton('play', '播放', function () {
        if (opts.onPlay) opts.onPlay(index)
        else playSongs([song], 0)
      }, 'play'),
    )
    actions.appendChild(
      actionButton('add', '加入播放列表', function () {
        enqueueSong(song)
        toast('已加入播放列表')
      }),
    )
    if (opts.onImport) {
      actions.appendChild(
        actionButton('download', '导入到曲库', function () {
          opts.onImport(song)
        }),
      )
    }
    actions.appendChild(
      actionButton('link', '解析播放链接', function () {
        openUrlDialog(song)
      }),
    )
    row.appendChild(actions)

    if (opts.onPlay) {
      row.addEventListener('dblclick', function () {
        opts.onPlay(index)
      })
    }
    if (playerState.index >= 0 && playerState.queue[playerState.index] && songKey(playerState.queue[playerState.index]) === songKey(song)) {
      row.classList.add('playing')
    }
    return row
  }

  function renderSongRows(container, songs, options) {
    if (!container) return
    container.innerHTML = ''
    if (!songs.length) {
      var empty = el('li', 'empty-state')
      empty.appendChild(svgIcon((options && options.emptyIcon) || 'music'))
      empty.appendChild(el('p', '', (options && options.emptyText) || '暂无歌曲'))
      container.appendChild(empty)
      return
    }
    songs.forEach(function (song, index) {
      container.appendChild(createSongRow(song, index, options))
    })
  }

  function statusLine(selector, message, isError) {
    var node = $(selector)
    if (!node) return
    node.textContent = message || ''
    node.classList.toggle('error', !!isError)
  }

  function setButtonLoading(button, loading, text) {
    if (!button) return
    if (loading) {
      if (button.dataset.original === undefined) button.dataset.original = button.innerHTML
      button.disabled = true
      button.textContent = text || '加载中…'
    } else {
      button.disabled = false
      if (button.dataset.original !== undefined) {
        button.innerHTML = button.dataset.original
        delete button.dataset.original
      }
    }
  }

  /* ================= 导入歌曲 ================= */

  function importableSongs(songs) {
    return songs.filter(function (song) {
      return song && song.source_data && (song.source_data.platform || song.platform)
    })
  }

  async function importSongs(songs, playlistName, button) {
    var payloadSongs = importableSongs(songs)
    if (!payloadSongs.length) {
      toast('没有可导入的歌曲（缺少 source_data）', 'warn')
      return false
    }
    var original = button ? button.innerHTML : ''
    if (button) {
      button.disabled = true
      button.textContent = '导入中…'
    }
    try {
      var body = {
        songs: payloadSongs.map(function (song) {
          return {
            title: song.title,
            artist: song.artist,
            album: song.album,
            cover_url: song.cover_url,
            duration: song.duration,
            source_data: song.source_data,
          }
        }),
        with_lyric: true,
      }
      var name = String(playlistName || '').trim()
      if (name) body.playlist_name = name
      var result = await api('songs/import', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      var data = result.data || {}
      var parts = ['已导入 ' + (data.added || 0) + '/' + (data.requested || payloadSongs.length) + ' 首']
      if (data.skipped) parts.push('跳过 ' + data.skipped + ' 首')
      if (data.playlist_id) parts.push('歌单：' + (data.playlist_name || '#' + data.playlist_id))
      toast(parts.join('，'), result.warning ? 'warn' : '')
      if (result.warning) setTimeout(function () { toast(result.warning, 'warn') }, 1600)
      state.local.songs = []
      state.local.offset = 0
      state.local.hasMore = true
      state.local.playlistsLoaded = false
      return true
    } catch (err) {
      toast('导入失败：' + errorMessage(err), 'error')
      return false
    } finally {
      if (button) {
        button.disabled = false
        button.innerHTML = original
      }
    }
  }

  /* ================= 搜索页 ================= */

  function syncSelectionUI() {
    var count = state.search.selected.size
    var info = $('#selection-info')
    if (info) info.textContent = '已选 ' + count + ' 首'
    var importButton = $('#import-selected')
    if (importButton) importButton.disabled = count === 0
    var selectAll = $('#select-all')
    if (selectAll) {
      var total = state.search.songs.length
      selectAll.checked = total > 0 && count === total
      selectAll.indeterminate = count > 0 && count < total
    }
  }

  function renderSearchResults() {
    var options = {
      selectable: true,
      selectedSet: state.search.selected,
      indexOffset: 0,
      emptyIcon: 'search',
      emptyText: state.search.keyword ? '没有找到相关歌曲，换个关键词试试' : '输入关键词开始搜索',
      onSelectionChange: syncSelectionUI,
      onPlay: function (index) {
        playSongs(state.search.songs, index)
      },
      onImport: function (song) {
        var nameInput = $('#playlist-name')
        importSongs([song], nameInput ? nameInput.value : '')
      },
    }
    renderSongRows($('#search-results'), state.search.songs, options)
    var loadMore = $('#load-more')
    if (loadMore) loadMore.classList.toggle('hidden', !state.search.hasMore)
    syncSelectionUI()
  }

  async function performSearch(reset) {
    var input = $('#search-input')
    var keyword = input ? input.value.trim() : ''
    var typeSelect = $('#search-type')
    var type = typeSelect ? typeSelect.value : 'song'
    if (!keyword) {
      toast('请输入搜索关键词')
      if (input) input.focus()
      return
    }
    if (type === 'playlist') {
      state.songlist.keyword = keyword
      state.songlist.tagId = ''
      state.songlist.page = 1
      state.songlist.lists = []
      navigate('songlist', { skipLoad: true })
      var songlistInput = $('#songlist-search')
      if (songlistInput) songlistInput.value = keyword
      if (!state.songlist.tagsLoaded) await loadSonglistMeta()
      else renderSonglistTags(state.songlist.tagsData)
      await loadSonglistPage(1, true)
      return
    }

    if (reset) {
      state.search.keyword = keyword
      state.search.platform = $('#search-platform') ? $('#search-platform').value : ''
      state.search.quality = $('#search-quality') ? $('#search-quality').value : state.quality
      state.search.page = 1
      state.search.songs = []
      state.search.selected.clear()
      state.search.hasMore = false
      renderSearchResults()
    }
    if (!state.search.keyword) return

    var page = state.search.page
    var seq = ++state.search.seq
    state.search.loading = true
    setButtonLoading($('#search-btn'), true, '搜索中…')
    statusLine('#search-status', reset ? '正在搜索「' + state.search.keyword + '」…' : '正在加载第 ' + page + ' 页…')
    try {
      var result = await api('search', {
        method: 'POST',
        body: JSON.stringify({
          keyword: state.search.keyword,
          source_id: state.search.platform,
          quality: state.search.quality || state.quality,
          page: page,
          page_size: SEARCH_PAGE_SIZE,
        }),
      })
      if (seq !== state.search.seq) return
      var data = result.data || {}
      var items = (Array.isArray(data.results) ? data.results : []).map(normalizeSearchSong)
      state.search.songs = reset ? items : state.search.songs.concat(items)
      state.search.page = page + 1
      state.search.hasMore = items.length >= SEARCH_PAGE_SIZE
      renderSearchResults()
      if (!state.search.songs.length) {
        statusLine('#search-status', '没有找到与「' + state.search.keyword + '」相关的歌曲，换个关键词试试。')
      } else {
        statusLine('#search-status', '共加载 ' + state.search.songs.length + ' 首歌曲' + (state.search.hasMore ? '，可继续加载' : ''))
      }
    } catch (err) {
      if (seq !== state.search.seq) return
      statusLine('#search-status', '搜索失败：' + errorMessage(err), true)
    } finally {
      if (seq === state.search.seq) {
        state.search.loading = false
        setButtonLoading($('#search-btn'), false)
      }
    }
  }

  async function loadHot(force) {
    var auto = true
    try {
      auto = localStorage.getItem(LS_HOT) !== '0'
    } catch (err) {
      auto = true
    }
    if (!auto && !force) {
      var list = $('#hot-list')
      if (list) {
        list.innerHTML = ''
        list.appendChild(el('span', 'muted', '已关闭热搜自动加载'))
      }
      return
    }
    var select = $('#search-platform')
    var platform = (select && select.value) || 'wy'
    var label = $('#hot-platform')
    if (label) {
      label.className = 'tag tag-' + platform
      label.textContent = platformShort(platform)
    }
    if (!force && state.hotLoadedFor === platform && $('#hot-list') && $('#hot-list').children.length) return
    state.hotLoadedFor = platform
    var container = $('#hot-list')
    if (!container) return
    container.innerHTML = ''
    container.appendChild(el('span', 'muted', '正在加载热搜…'))
    try {
      var result = await api('hot?platform=' + encodeURIComponent(platform))
      var data = result.data || {}
      var words = Array.isArray(data.list) ? data.list : []
      container.innerHTML = ''
      if (!words.length) {
        container.appendChild(el('span', 'muted', '暂无热搜，点击刷新重试'))
        return
      }
      words.slice(0, 24).forEach(function (word, index) {
        var chip = el('button', 'hot-chip' + (index < 3 ? ' top' : ''))
        chip.type = 'button'
        chip.appendChild(el('span', 'rank', String(index + 1)))
        chip.appendChild(el('span', '', word))
        chip.addEventListener('click', function () {
          var input = $('#search-input')
          if (input) input.value = word
          var typeSelect = $('#search-type')
          if (typeSelect) typeSelect.value = 'song'
          performSearch(true)
        })
        container.appendChild(chip)
      })
    } catch (err) {
      container.innerHTML = ''
      var retry = el('button', 'hot-chip', '热搜加载失败，点击重试')
      retry.type = 'button'
      retry.addEventListener('click', function () {
        loadHot(true)
      })
      container.appendChild(retry)
    }
  }

  async function importSelectedSongs() {
    var selected = state.search.songs.filter(function (song) {
      return state.search.selected.has(songKey(song))
    })
    if (!selected.length) {
      toast('请先选择要导入的歌曲')
      return
    }
    var nameInput = $('#playlist-name')
    var ok = await importSongs(selected, nameInput ? nameInput.value : '', $('#import-selected'))
    if (ok) {
      state.search.selected.clear()
      renderSearchResults()
    }
  }

  /* ================= 歌单页 ================= */

  function tagValue(tag) {
    if (tag && typeof tag === 'object') return String(tag.id !== undefined ? tag.id : tag.tag_id !== undefined ? tag.tag_id : tag.name || '')
    return String(tag || '')
  }

  function tagName(tag) {
    if (tag && typeof tag === 'object') return String(tag.name || tag.title || tag.id || '')
    return String(tag || '')
  }

  function renderSonglistTags(data) {
    if (data) state.songlist.tagsData = data
    var container = $('#songlist-tags')
    if (!container) return
    container.innerHTML = ''
    var tags = []
    var source = state.songlist.tagsData || {}
    var hot = Array.isArray(source.hotTag) ? source.hotTag : []
    var normal = Array.isArray(source.tags) ? source.tags : []
    var seen = {}
    function push(tag) {
      var value = tagValue(tag)
      if (!value || seen[value]) return
      seen[value] = true
      tags.push({ value: value, name: tagName(tag) })
    }
    hot.forEach(push)
    normal.forEach(push)

    var all = el('button', 'tag-chip' + (state.songlist.tagId ? '' : ' active'), '全部')
    all.type = 'button'
    all.addEventListener('click', function () {
      state.songlist.tagId = ''
      clearSonglistKeyword()
      $all('.tag-chip', container).forEach(function (item) {
        item.classList.toggle('active', item === all)
      })
      loadSonglistPage(1, true)
    })
    container.appendChild(all)
    tags.forEach(function (tag) {
      var chip = el('button', 'tag-chip' + (state.songlist.tagId === tag.value ? ' active' : ''), tag.name)
      chip.type = 'button'
      chip.addEventListener('click', function () {
        state.songlist.tagId = tag.value
        clearSonglistKeyword()
        $all('.tag-chip', container).forEach(function (item) {
          item.classList.toggle('active', item === chip)
        })
        loadSonglistPage(1, true)
      })
      container.appendChild(chip)
    })
  }

  function clearSonglistKeyword() {
    state.songlist.keyword = ''
    var input = $('#songlist-search')
    if (input) input.value = ''
  }

  function startSonglistSearch() {
    var input = $('#songlist-search')
    var keyword = input ? input.value.trim() : ''
    state.songlist.keyword = keyword
    if (keyword) {
      state.songlist.tagId = ''
      renderSonglistTags(state.songlist.tagsData)
    }
    loadSonglistPage(1, true)
  }

  async function loadSonglistMeta() {
    var select = $('#songlist-platform')
    var platform = (select && select.value) || state.songlist.platform || 'wy'
    state.songlist.platform = platform
    var sortSelect = $('#songlist-sort')
    if (sortSelect) sortSelect.innerHTML = ''
    try {
      var result = await api('songlist/tags?platform=' + encodeURIComponent(platform))
      var data = result.data || {}
      var sorts = Array.isArray(data.sorts) ? data.sorts : []
      if (sortSelect) {
        sortSelect.innerHTML = ''
        sorts.forEach(function (sort) {
          sortSelect.appendChild(new Option(sort.name || sort.id, sort.id))
        })
        if (sorts.length) {
          state.songlist.sortId = sorts[0].id
          sortSelect.value = sorts[0].id
        } else {
          state.songlist.sortId = ''
        }
      }
      renderSonglistTags(data)
      state.songlist.tagsLoaded = true
    } catch (err) {
      statusLine('#songlist-status', '读取歌单分类失败：' + errorMessage(err), true)
      state.songlist.tagsLoaded = true
      renderSonglistTags(null)
    }
  }

  async function loadSonglistPage(page, reset) {
    var select = $('#songlist-platform')
    var platform = (select && select.value) || state.songlist.platform
    state.songlist.platform = platform || state.songlist.platform
    var keyword = state.songlist.keyword.trim()
    var sortSelect = $('#songlist-sort')
    var sortId = sortSelect ? sortSelect.value : state.songlist.sortId
    state.songlist.sortId = sortId
    if (reset) {
      state.songlist.page = page
      state.songlist.hasMore = false
      state.songlist.lists = []
      renderSonglist()
    }
    var seq = ++state.songlist.pageSeq
    statusLine('#songlist-status', reset ? '正在加载歌单…' : '正在加载第 ' + page + ' 页…')
    try {
      var result
      if (keyword) {
        result = await api('songlist/search?platform=' + encodeURIComponent(platform) + '&keyword=' + encodeURIComponent(keyword) + '&page=' + page)
      } else {
        result = await api(
          'songlist/list?platform=' +
            encodeURIComponent(platform) +
            '&sort_id=' +
            encodeURIComponent(sortId || '') +
            '&tag_id=' +
            encodeURIComponent(state.songlist.tagId || '') +
            '&page=' +
            page,
        )
      }
      if (seq !== state.songlist.pageSeq) return
      var data = result.data || {}
      var lists = (Array.isArray(data.list) ? data.list : []).map(function (item) {
        return normalizePlaylist(item, platform)
      })
      state.songlist.lists = reset ? lists : state.songlist.lists.concat(lists)
      state.songlist.total = Number(data.total) || 0
      state.songlist.page = page
      state.songlist.hasMore = lists.length > 0
      renderSonglist()
      var loaded = state.songlist.lists.length
      statusLine('#songlist-status', keyword ? '搜索「' + keyword + '」：' + loaded + ' 个歌单' : '共 ' + (state.songlist.total || loaded) + ' 个歌单，已加载 ' + loaded + ' 个')
    } catch (err) {
      if (seq !== state.songlist.pageSeq) return
      statusLine('#songlist-status', '获取歌单失败：' + errorMessage(err), true)
      if (reset) {
        state.songlist.lists = []
        renderSonglist()
      }
    } finally {
      if (seq === state.songlist.pageSeq) {
        var pageLabel = $('#songlist-page')
        if (pageLabel) pageLabel.textContent = '第 ' + state.songlist.page + ' 页'
      }
    }
  }

  function renderSonglist() {
    var grid = $('#songlist-grid')
    if (!grid) return
    grid.innerHTML = ''
    if (!state.songlist.lists.length) {
      var empty = el('div', 'empty-state')
      empty.appendChild(svgIcon('playlist'))
      empty.appendChild(el('p', '', state.songlist.keyword ? '没有找到相关歌单' : '这里空空如也~'))
      grid.appendChild(empty)
    } else {
      state.songlist.lists.forEach(function (item) {
        grid.appendChild(createPlaylistCard(item, function () {
          openSonglistDetail(item)
        }))
      })
    }
    var prev = $('#songlist-prev')
    var next = $('#songlist-next')
    if (prev) prev.disabled = state.songlist.page <= 1
    if (next) next.disabled = !state.songlist.hasMore
  }

  function createPlaylistCard(item, onOpen) {
    var card = el('button', 'playlist-card')
    card.type = 'button'
    var cover = el('div', 'playlist-cover')
    var src = imageUrl(item.cover_url)
    if (src) {
      var img = document.createElement('img')
      img.loading = 'lazy'
      img.alt = ''
      img.referrerPolicy = 'no-referrer'
      img.src = src
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.removeChild(img)
        if (!cover.querySelector('.icon')) cover.appendChild(svgIcon('music'))
      })
      cover.appendChild(img)
    } else {
      cover.appendChild(svgIcon('music'))
    }
    var count = formatCount(item.play_count)
    if (count) cover.appendChild(el('span', 'playlist-count', count))
    card.appendChild(cover)
    card.appendChild(el('div', 'playlist-name', item.name))
    var subParts = []
    if (item.author) subParts.push(item.author)
    if (item.total) subParts.push(item.total + ' 首')
    card.appendChild(el('div', 'playlist-sub', subParts.join(' · ') || platformShort(item.platform)))
    card.addEventListener('click', onOpen)
    return card
  }

  async function ensureSonglist() {
    if (!state.songlist.tagsLoaded) await loadSonglistMeta()
    if (!state.songlist.lists.length) await loadSonglistPage(1, true)
  }

  async function openSonglistDetail(item) {
    state.songlist.detail = item
    state.songlist.detailSongs = []
    state.songlist.detailPage = 1
    state.songlist.detailHasMore = false
    state.songlist.detailTotal = 0
    var browse = $('#songlist-browse')
    var detail = $('#songlist-detail')
    if (browse) browse.classList.add('hidden')
    if (detail) detail.classList.remove('hidden')
    var name = $('#songlist-detail-name')
    if (name) name.textContent = item.name
    var meta = $('#songlist-detail-meta')
    if (meta) {
      meta.textContent = [item.author, item.total ? item.total + ' 首' : '', platformName(item.platform)].filter(Boolean).join(' · ')
    }
    var desc = $('#songlist-detail-desc')
    if (desc) desc.textContent = item.description || ''
    appendCover($('#songlist-detail-cover'), item.cover_url)
    await loadSonglistDetail(1, true)
  }

  async function loadSonglistDetail(page, reset) {
    var item = state.songlist.detail
    if (!item) return
    var seq = ++state.songlist.detailSeq
    statusLine('#songlist-detail-status', reset ? '正在读取歌单歌曲…' : '正在加载第 ' + page + ' 页…')
    try {
      var result = await api(
        'songlist/detail?platform=' +
          encodeURIComponent(item.platform) +
          '&id=' +
          encodeURIComponent(item.id) +
          '&page=' +
          page +
          '&quality=' +
          encodeURIComponent(state.quality),
      )
      if (seq !== state.songlist.detailSeq) return
      var data = result.data || {}
      var songs = (Array.isArray(data.list) ? data.list : []).map(normalizeSearchSong)
      state.songlist.detailSongs = reset ? songs : state.songlist.detailSongs.concat(songs)
      state.songlist.detailPage = page
      state.songlist.detailTotal = Number(data.total) || state.songlist.detailSongs.length
      state.songlist.detailHasMore = songs.length > 0
      if (data.info) {
        var meta = $('#songlist-detail-meta')
        if (meta) {
          meta.textContent = [item.author, state.songlist.detailTotal + ' 首', platformName(item.platform)].filter(Boolean).join(' · ')
        }
        if (data.info.description) {
          var desc = $('#songlist-detail-desc')
          if (desc) desc.textContent = data.info.description
        }
        if (data.info.cover_url) appendCover($('#songlist-detail-cover'), data.info.cover_url)
      }
      renderSonglistDetail()
      statusLine('#songlist-detail-status', '已加载 ' + state.songlist.detailSongs.length + ' / ' + state.songlist.detailTotal + ' 首')
    } catch (err) {
      if (seq !== state.songlist.detailSeq) return
      statusLine('#songlist-detail-status', '读取歌单歌曲失败：' + errorMessage(err), true)
    }
  }

  function renderSonglistDetail() {
    var songs = state.songlist.detailSongs
    renderSongRows($('#songlist-detail-songs'), songs, {
      indexOffset: 0,
      emptyIcon: 'music',
      emptyText: '这个歌单还没有歌曲',
      onPlay: function (index) {
        playSongs(songs, index)
      },
      onImport: function (song) {
        importSongs([song], '')
      },
    })
    var more = $('#songlist-detail-more')
    if (more) more.classList.toggle('hidden', !state.songlist.detailHasMore)
  }

  /* ================= 排行榜页 ================= */

  async function ensureLeaderboard() {
    if (!state.leaderboard.boards.length) await loadBoards()
  }

  async function loadBoards() {
    var select = $('#leaderboard-platform')
    var platform = (select && select.value) || state.leaderboard.platform || 'wy'
    state.leaderboard.platform = platform
    var seq = ++state.leaderboard.boardsSeq
    statusLine('#board-status', '正在加载榜单…')
    try {
      var result = await api('leaderboard/boards?platform=' + encodeURIComponent(platform))
      if (seq !== state.leaderboard.boardsSeq) return
      var data = result.data || {}
      state.leaderboard.boards = Array.isArray(data.boards) ? data.boards : []
      renderBoards()
      if (state.leaderboard.boards.length) {
        await selectBoard(state.leaderboard.boards[0])
      } else {
        state.leaderboard.activeBoard = null
        renderBoardSongs()
        statusLine('#board-status', '该平台暂无榜单')
      }
    } catch (err) {
      if (seq !== state.leaderboard.boardsSeq) return
      state.leaderboard.boards = []
      renderBoards()
      statusLine('#board-status', '榜单加载失败，请检查网络或音源后重试：' + errorMessage(err), true)
    }
  }

  function renderBoards() {
    var list = $('#board-list')
    if (!list) return
    list.innerHTML = ''
    if (!state.leaderboard.boards.length) {
      var empty = el('li', 'empty-state small')
      empty.appendChild(svgIcon('chart'))
      empty.appendChild(el('p', '', '暂无榜单'))
      list.appendChild(empty)
      return
    }
    state.leaderboard.boards.forEach(function (board) {
      var item = el('li')
      var button = el('button', 'board-item' + (state.leaderboard.activeBoard && state.leaderboard.activeBoard.id === board.id ? ' active' : ''), board.name || board.id)
      button.type = 'button'
      button.addEventListener('click', function () {
        selectBoard(board)
      })
      item.appendChild(button)
      list.appendChild(item)
    })
  }

  async function selectBoard(board) {
    state.leaderboard.activeBoard = board
    renderBoards()
    var title = $('#board-title')
    if (title) title.textContent = board.name || '榜单'
    var meta = $('#board-meta')
    if (meta) meta.textContent = platformName(state.leaderboard.platform)
    await loadBoardSongs(1, true)
  }

  async function loadBoardSongs(page, reset) {
    var board = state.leaderboard.activeBoard
    if (!board) return
    var seq = ++state.leaderboard.songsSeq
    if (reset) {
      state.leaderboard.page = page
      state.leaderboard.hasMore = false
      state.leaderboard.songs = []
      renderBoardSongs()
    }
    statusLine('#board-status', reset ? '正在加载榜单歌曲…' : '正在加载第 ' + page + ' 页…')
    try {
      var result = await api(
        'leaderboard/list?platform=' +
          encodeURIComponent(state.leaderboard.platform) +
          '&board_id=' +
          encodeURIComponent(board.id) +
          '&page=' +
          page +
          '&quality=' +
          encodeURIComponent(state.quality),
      )
      if (seq !== state.leaderboard.songsSeq) return
      var data = result.data || {}
      var songs = (Array.isArray(data.list) ? data.list : []).map(normalizeSearchSong)
      state.leaderboard.songs = reset ? songs : state.leaderboard.songs.concat(songs)
      state.leaderboard.page = page
      state.leaderboard.total = Number(data.total) || state.leaderboard.songs.length
      state.leaderboard.hasMore = songs.length > 0
      renderBoardSongs()
      statusLine('#board-status', '共 ' + (state.leaderboard.total || state.leaderboard.songs.length) + ' 首，已加载 ' + state.leaderboard.songs.length + ' 首')
    } catch (err) {
      if (seq !== state.leaderboard.songsSeq) return
      statusLine('#board-status', '榜单歌曲加载失败：' + errorMessage(err), true)
    }
  }

  function renderBoardSongs() {
    var songs = state.leaderboard.songs
    renderSongRows($('#board-songs'), songs, {
      indexOffset: 0,
      emptyIcon: 'chart',
      emptyText: '请选择左侧榜单',
      onPlay: function (index) {
        playSongs(songs, index)
      },
      onImport: function (song) {
        importSongs([song], '')
      },
    })
    var more = $('#board-more')
    if (more) more.classList.toggle('hidden', !state.leaderboard.hasMore)
  }

  /* ================= 本地音乐 ================= */

  async function ensureLocal() {
    if (!state.local.songs.length && !state.local.loading) await loadLocalSongs(true)
    if (state.local.view === 'playlists' && !state.local.playlistsLoaded) await loadLocalPlaylists()
  }

  async function loadLocalSongs(reset) {
    if (state.local.loading) return
    state.local.loading = true
    if (reset) {
      state.local.songs = []
      state.local.offset = 0
      state.local.total = 0
      state.local.hasMore = false
      renderLocalSongs()
    }
    statusLine('#local-status', '正在读取本地曲库…')
    try {
      var data = await hostApi('/api/v1/songs?limit=' + LOCAL_PAGE_SIZE + '&offset=' + state.local.offset)
      var songs = (Array.isArray(data && data.songs) ? data.songs : []).map(normalizeHostSong)
      state.local.songs = reset ? songs : state.local.songs.concat(songs)
      state.local.offset += songs.length
      state.local.total = Number(data && data.total) || state.local.songs.length
      state.local.hasMore = songs.length >= LOCAL_PAGE_SIZE && state.local.songs.length < (state.local.total || Infinity)
      renderLocalSongs()
    } catch (err) {
      statusLine('#local-status', '本地曲库加载失败，请检查与 Songloft 的连接后重试：' + errorMessage(err), true)
    } finally {
      state.local.loading = false
    }
  }

  function filteredLocalSongs() {
    var keyword = state.local.keyword.trim().toLowerCase()
    if (!keyword) return state.local.songs
    return state.local.songs.filter(function (song) {
      return (song.title + ' ' + song.artist + ' ' + song.album).toLowerCase().indexOf(keyword) >= 0
    })
  }

  function renderLocalSongs() {
    var songs = filteredLocalSongs()
    renderSongRows($('#local-songs'), songs, {
      indexOffset: 0,
      emptyIcon: 'library',
      emptyText: state.local.keyword ? '没有匹配的本地歌曲' : '本地曲库还没有歌曲，可在搜索页导入',
      onPlay: function (index) {
        playSongs(songs, index)
      },
    })
    var status = state.local.keyword
      ? '筛选出 ' + songs.length + ' 首'
      : '共 ' + (state.local.total || state.local.songs.length) + ' 首，已加载 ' + state.local.songs.length + ' 首'
    statusLine('#local-status', status)
    var more = $('#local-more')
    if (more) more.classList.toggle('hidden', !state.local.hasMore)
  }

  async function loadLocalPlaylists() {
    statusLine('#local-playlist-status', '正在读取本地歌单…')
    try {
      var data = await hostApi('/api/v1/playlists?limit=1000&offset=0')
      var lists = Array.isArray(data && data.playlists) ? data.playlists : Array.isArray(data) ? data : []
      state.local.playlists = lists.map(function (item) {
        return normalizePlaylist(item, '')
      })
      state.local.playlistsLoaded = true
      renderLocalPlaylists()
    } catch (err) {
      statusLine('#local-playlist-status', '本地歌单加载失败：' + errorMessage(err), true)
    }
  }

  function renderLocalPlaylists() {
    var grid = $('#local-playlists')
    if (!grid) return
    grid.innerHTML = ''
    var keyword = state.local.keyword.trim().toLowerCase()
    var lists = state.local.playlists.filter(function (item) {
      return !keyword || item.name.toLowerCase().indexOf(keyword) >= 0
    })
    if (!lists.length) {
      var empty = el('div', 'empty-state')
      empty.appendChild(svgIcon('playlist'))
      empty.appendChild(el('p', '', keyword ? '没有匹配的本地歌单' : '还没有本地歌单'))
      grid.appendChild(empty)
    } else {
      lists.forEach(function (item) {
        grid.appendChild(
          createPlaylistCard(item, function () {
            openLocalPlaylist(item)
          }),
        )
      })
    }
    statusLine('#local-playlist-status', '共 ' + lists.length + ' 个歌单')
  }

  async function openLocalPlaylist(item) {
    state.local.detail = item
    state.local.detailSongs = []
    $('#local-songs-view').classList.add('hidden')
    $('#local-playlists-view').classList.add('hidden')
    $('#local-playlist-detail').classList.remove('hidden')
    var name = $('#local-playlist-name')
    if (name) name.textContent = item.name
    var meta = $('#local-playlist-meta')
    if (meta) meta.textContent = (item.cover_url ? '' : '') + (item.description || '')
    appendCover($('#local-playlist-cover'), item.cover_url)
    var list = $('#local-playlist-songs')
    if (list) {
      list.innerHTML = ''
      var loading = el('div', 'empty-state small')
      loading.appendChild(el('p', '', '正在读取歌单歌曲…'))
      list.appendChild(loading)
    }
    try {
      var data = await hostApi(
        '/api/v1/playlists/' + encodeURIComponent(item.id) + '/songs?limit=1000&offset=0&sort=position&order=asc',
      )
      var songs = (Array.isArray(data && data.songs) ? data.songs : []).map(normalizeHostSong)
      state.local.detailSongs = songs
      renderLocalPlaylistDetail()
    } catch (err) {
      if (list) {
        list.innerHTML = ''
        var empty = el('div', 'empty-state small')
        empty.appendChild(el('p', '', '读取歌单歌曲失败：' + errorMessage(err)))
        list.appendChild(empty)
      }
    }
  }

  function renderLocalPlaylistDetail() {
    var item = state.local.detail
    var songs = state.local.detailSongs
    var meta = $('#local-playlist-meta')
    if (meta) {
      meta.textContent = [songs.length + ' 首', item && item.description].filter(Boolean).join(' · ')
    }
    renderSongRows($('#local-playlist-songs'), songs, {
      indexOffset: 0,
      emptyIcon: 'playlist',
      emptyText: '这个歌单还没有歌曲',
      onPlay: function (index) {
        playSongs(songs, index)
      },
    })
  }

  function switchLocalView(view) {
    state.local.view = view === 'playlists' ? 'playlists' : 'songs'
    state.local.detail = null
    $all('.view-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-local-view') === state.local.view)
    })
    $('#local-songs-view').classList.toggle('hidden', state.local.view !== 'songs')
    $('#local-playlists-view').classList.toggle('hidden', state.local.view !== 'playlists')
    $('#local-playlist-detail').classList.add('hidden')
    if (state.local.view === 'playlists' && !state.local.playlistsLoaded) loadLocalPlaylists()
    if (state.local.view === 'songs') renderLocalSongs()
    else renderLocalPlaylists()
  }

  /* ================= 设置 / 音源管理 ================= */

  function sourceStatus(source) {
    if (!source.enabled) return { key: 'disabled', label: '已停用' }
    if (source.status === 'ready') return { key: 'ok', label: '就绪' }
    if (source.status === 'loading') return { key: 'warn', label: '加载中' }
    if (source.status === 'error') return { key: 'bad', label: '加载失败' }
    return { key: '', label: '待加载' }
  }

  function updateSourceBrief() {
    var sources = state.sources.items
    var ready = sources.filter(function (item) {
      return item.status === 'ready'
    }).length
    var text = sources.length ? '音源 ' + ready + '/' + sources.length + ' 就绪' : '尚未导入音源'
    var brief = $('#sidebar-status')
    if (brief) brief.textContent = text
    var top = $('#topbar-status')
    if (top) top.textContent = sources.length ? '音源就绪 ' + ready + '/' + sources.length : ''
  }

  function renderSources() {
    var list = $('#source-list')
    if (!list) return
    list.innerHTML = ''
    var sources = state.sources.items
    var enabled = sources.filter(function (item) {
      return item.enabled
    }).length
    var ready = sources.filter(function (item) {
      return item.status === 'ready'
    }).length
    var summary = $('#sources-summary')
    if (summary) {
      summary.textContent = sources.length
        ? '共 ' + sources.length + ' 个音源 · 已启用 ' + enabled + ' 个 · 就绪 ' + ready + ' 个'
        : '尚未导入音源。播放链接解析需要先导入洛雪音源脚本。'
    }
    updateSourceBrief()

    var banner = $('#batch-banner')
    var pending = state.sources.batchPending.length
    if (banner) {
      if (state.sources.batchLoading || pending) {
        banner.classList.remove('hidden')
        var current = state.sources.batchCurrent
        var currentSource = current
          ? sources.filter(function (item) {
              return item.id === current
            })[0]
          : null
        banner.textContent =
          '后台加载中' + (currentSource ? '：' + currentSource.name : '') + (pending ? '，队列还有 ' + pending + ' 个音源' : '') + '…'
      } else {
        banner.classList.add('hidden')
        banner.textContent = ''
      }
    }

    if (!sources.length) {
      var empty = el('li', 'empty-state small')
      empty.appendChild(svgIcon('settings'))
      empty.appendChild(el('p', '', '暂无音源，请在下方导入 .js / .zip 脚本'))
      list.appendChild(empty)
      return
    }

    sources.forEach(function (source) {
      list.appendChild(sourceItem(source))
    })
  }

  function sourceItem(source) {
    var li = el('li', 'source-item')
    if (state.sources.batchCurrent === source.id) li.classList.add('batch-current')

    var head = el('div', 'source-head')
    head.appendChild(el('h3', 'source-name', source.name || source.id))
    if (source.version) head.appendChild(el('span', 'chip', 'v' + source.version))
    var status = sourceStatus(source)
    head.appendChild(el('span', 'chip ' + status.key, status.label))
    if (state.sources.batchCurrent === source.id) head.appendChild(el('span', 'chip warn', '当前加载'))
    else if (state.sources.batchPending.indexOf(source.id) >= 0) head.appendChild(el('span', 'chip', '排队中'))

    var actions = el('div', 'source-actions')
    var switchLabel = el('label', 'switch')
    var toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = !!source.enabled
    toggle.disabled = state.sources.batchCurrent === source.id
    toggle.setAttribute('aria-label', '启用 ' + (source.name || source.id))
    toggle.addEventListener('change', function () {
      toggleSource(source, toggle)
    })
    switchLabel.appendChild(toggle)
    switchLabel.appendChild(el('span', '', source.enabled ? '已启用' : '已停用'))
    actions.appendChild(switchLabel)

    var remove = el('button', 'icon-btn')
    remove.type = 'button'
    remove.title = '删除音源'
    remove.appendChild(svgIcon('delete'))
    remove.addEventListener('click', function () {
      deleteSource(source)
    })
    actions.appendChild(remove)
    head.appendChild(actions)
    li.appendChild(head)

    if (source.description) li.appendChild(el('p', 'source-desc', source.description))

    var meta = el('div', 'source-meta')
    if (source.author) meta.appendChild(el('span', '', '作者：' + source.author))
    if (source.homepage) meta.appendChild(el('span', '', '主页：' + source.homepage))
    var stats = source.stats || {}
    meta.appendChild(el('span', '', '解析成功 ' + (stats.successCalls || 0) + '/' + (stats.totalCalls || 0)))
    if (source.size) meta.appendChild(el('span', '', formatSize(source.size)))
    li.appendChild(meta)

    var platforms = Array.isArray(source.platforms) ? source.platforms : []
    if (platforms.length) {
      var row = el('div', 'source-platforms')
      platforms.forEach(function (platform) {
        var qualitys = Array.isArray(platform.qualitys) && platform.qualitys.length ? ' · ' + platform.qualitys.join('/') : ''
        row.appendChild(el('span', 'chip', platformName(platform.platform) + qualitys))
      })
      li.appendChild(row)
    }

    if (source.status === 'error' && source.error) {
      li.appendChild(el('p', 'source-error', source.error))
    }
    return li
  }

  function formatSize(bytes) {
    var n = Number(bytes) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }

  async function refreshSources(silent) {
    if (state.sources.requesting) return
    state.sources.requesting = true
    try {
      var result = await api('sources')
      var data = result.data || {}
      state.sources.items = Array.isArray(data.sources) ? data.sources : []
      state.sources.batchLoading = !!data.loading
      state.sources.batchCurrent = data.batch_current_id || null
      state.sources.batchPending = Array.isArray(data.batch_pending_ids) ? data.batch_pending_ids : []
      renderSources()
      if (data.loading) scheduleSourcePoll()
    } catch (err) {
      if (!silent) toast('读取音源列表失败：' + errorMessage(err), 'error')
      updateSourceBrief()
    } finally {
      state.sources.requesting = false
    }
  }

  function scheduleSourcePoll() {
    if (state.sources.pollTimer) clearTimeout(state.sources.pollTimer)
    state.sources.pollTimer = setTimeout(function () {
      state.sources.pollTimer = null
      refreshSources(true)
    }, 1500)
  }

  function startSourcePolling() {
    if (state.sources.pollTimer) clearTimeout(state.sources.pollTimer)
    state.sources.pollTimer = setTimeout(function () {
      state.sources.pollTimer = null
      refreshSources(true)
    }, 500)
  }

  async function toggleSource(source, toggle) {
    var enabled = toggle.checked
    toggle.disabled = true
    try {
      await api('sources/toggle', {
        method: 'PUT',
        body: JSON.stringify({ id: source.id, enabled: enabled }),
      })
      toast((enabled ? '已启用「' : '已停用「') + (source.name || source.id) + '」')
      await refreshSources(true)
      if (enabled) startSourcePolling()
    } catch (err) {
      toggle.checked = !enabled
      toast('操作失败：' + errorMessage(err), 'error')
    } finally {
      toggle.disabled = false
    }
  }

  async function deleteSource(source) {
    var name = source.name || source.id
    var ok = await askConfirm('删除音源', '确定删除音源「' + name + '」吗？脚本会同时从插件存储中移除。', '删除')
    if (!ok) return
    try {
      await api('sources?id=' + encodeURIComponent(source.id), { method: 'DELETE' })
      toast('已删除「' + name + '」')
      await refreshSources(true)
    } catch (err) {
      toast('删除失败：' + errorMessage(err), 'error')
    }
  }

  function renderImportFiles() {
    var list = $('#import-file-list')
    if (!list) return
    list.innerHTML = ''
    state.files.forEach(function (file, index) {
      var item = el('li', 'file-item')
      item.appendChild(el('span', 'name', file.name))
      item.appendChild(el('span', 'size', formatSize(file.size)))
      var remove = el('button', 'icon-btn')
      remove.type = 'button'
      remove.title = '移除'
      remove.appendChild(svgIcon('close'))
      remove.addEventListener('click', function () {
        state.files.splice(index, 1)
        renderImportFiles()
      })
      item.appendChild(remove)
      list.appendChild(item)
    })
    var button = $('#import-files-btn')
    if (button) button.disabled = state.files.length === 0
  }

  function addImportFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || [])
    files.forEach(function (file) {
      var name = String(file.name || '')
      if (!/\.(js|zip)$/i.test(name)) {
        toast('已忽略不支持的文件：' + name, 'warn')
        return
      }
      if (file.size > 8 * 1024 * 1024) {
        toast('文件超过 8MB，已忽略：' + name, 'warn')
        return
      }
      var exists = state.files.some(function (item) {
        return item.name === name && item.size === file.size
      })
      if (!exists) state.files.push(file)
    })
    renderImportFiles()
  }

  async function uploadSourceFiles() {
    if (!state.files.length) return
    var button = $('#import-files-btn')
    var original = button ? button.innerHTML : ''
    if (button) {
      button.disabled = true
      button.textContent = '导入中…'
    }
    try {
      var form = new FormData()
      state.files.forEach(function (file) {
        form.append('file', file, file.name)
      })
      var enable = $('#import-enable')
      form.append('enable', enable && enable.checked ? 'true' : 'false')
      var result = await api('sources/import', { method: 'POST', body: form })
      var data = result.data || {}
      var count = Array.isArray(data.imported) ? data.imported.length : 0
      var message = '已导入 ' + count + ' 个音源'
      if (data.batch || data.loading) message += '，正在后台逐个加载…'
      toast(message + (result.warning ? '；' + result.warning : ''), result.warning ? 'warn' : '')
      state.files = []
      renderImportFiles()
      startSourcePolling()
    } catch (err) {
      toast('导入失败：' + errorMessage(err), 'error')
    } finally {
      if (button) {
        button.disabled = state.files.length === 0
        button.innerHTML = original
      }
    }
  }

  async function importSourceUrl() {
    var input = $('#source-url-input')
    var url = input ? input.value.trim() : ''
    if (!url) {
      toast('请填写音源 URL')
      return
    }
    var button = $('#import-url-btn')
    var original = button ? button.textContent : ''
    if (button) {
      button.disabled = true
      button.textContent = '导入中…'
    }
    try {
      var enable = $('#import-enable')
      var result = await api('sources/import-url', {
        method: 'POST',
        body: JSON.stringify({ url: url, enable: !!(enable && enable.checked) }),
      })
      var data = result.data || {}
      var count = Array.isArray(data.imported) ? data.imported.length : 0
      var message = '已导入 ' + count + ' 个音源'
      if (data.batch || data.loading) message += '，正在后台加载…'
      toast(message + (result.warning ? '；' + result.warning : ''), result.warning ? 'warn' : '')
      if (input) input.value = ''
      startSourcePolling()
    } catch (err) {
      toast('导入失败：' + errorMessage(err), 'error')
    } finally {
      if (button) {
        button.disabled = false
        button.textContent = original
      }
    }
  }

  async function importSongsJson() {
    var textarea = $('#songs-json')
    var text = textarea ? textarea.value.trim() : ''
    if (!text) {
      toast('请先粘贴歌曲 JSON')
      return
    }
    var parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      toast('JSON 解析失败：' + errorMessage(err), 'error')
      return
    }
    var items = parsed
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.songs)) items = parsed.songs
    if (!Array.isArray(items) || !items.length) {
      toast('JSON 必须是歌曲数组，或包含 songs 数组', 'error')
      return
    }
    var button = $('#import-json-btn')
    var original = button ? button.innerHTML : ''
    if (button) {
      button.disabled = true
      button.textContent = '导入中…'
    }
    try {
      var body = { songs: items, with_lyric: true }
      var playlistInput = $('#import-playlist-name')
      var name = playlistInput ? playlistInput.value.trim() : ''
      if (name) body.playlist_name = name
      var result = await api('songs/import', { method: 'POST', body: JSON.stringify(body) })
      var data = result.data || {}
      var message = '已导入 ' + (data.added || 0) + '/' + (data.requested || items.length) + ' 首'
      if (data.skipped) message += '，跳过 ' + data.skipped + ' 首'
      if (result.warning) message += '；' + result.warning
      toast(message, result.warning || data.skipped ? 'warn' : '')
      state.local.songs = []
      state.local.offset = 0
      state.local.hasMore = true
      state.local.playlistsLoaded = false
    } catch (err) {
      toast('导入失败：' + errorMessage(err), 'error')
    } finally {
      if (button) {
        button.disabled = false
        button.innerHTML = original
      }
    }
  }

  function syncSettingsUI() {
    var qualitySelect = $('#default-quality')
    if (qualitySelect) qualitySelect.value = state.quality
    var hotCheckbox = $('#setting-hot')
    if (hotCheckbox) {
      try {
        hotCheckbox.checked = localStorage.getItem(LS_HOT) !== '0'
      } catch (err) {
        hotCheckbox.checked = true
      }
    }
  }

  function changeDefaultQuality(value) {
    state.quality = value
    try {
      localStorage.setItem(LS_QUALITY, value)
    } catch (err) {
      /* ignore */
    }
    var searchQuality = $('#search-quality')
    if (searchQuality) searchQuality.value = value
    toast('默认音质已设为 ' + qualityLabel(value))
  }

  function changeHotSetting(checked) {
    try {
      localStorage.setItem(LS_HOT, checked ? '1' : '0')
    } catch (err) {
      /* ignore */
    }
    if (checked) loadHot(true)
    else {
      var list = $('#hot-list')
      if (list) {
        list.innerHTML = ''
        list.appendChild(el('span', 'muted', '已关闭热搜自动加载'))
      }
    }
  }

  /* ================= 插件更新 ================= */

  var UPDATE_AUTO_HINT = '开启后由 Songloft 后台定时检查并安装新版本，更新完成后自动热重载。该开关为全站插件设置。'

  function hostPluginEntryPath() {
    return (state.meta && state.meta.entry_path) || 'lxmusic'
  }

  function findHostPlugin(payload) {
    var plugins = payload && Array.isArray(payload.plugins)
      ? payload.plugins
      : Array.isArray(payload)
        ? payload
        : []
    var entry = hostPluginEntryPath()
    for (var i = 0; i < plugins.length; i++) {
      if (plugins[i] && plugins[i].entry_path === entry) return plugins[i]
    }
    return null
  }

  async function fetchHostPlugin() {
    var payload = await hostApi('/api/v1/jsplugins')
    var plugin = findHostPlugin(payload)
    if (!plugin) {
      throw new Error('未在 Songloft 插件列表中找到 ' + hostPluginEntryPath() + '，请确认插件已安装')
    }
    return plugin
  }

  function updateErrorMessage(err, prefix) {
    var status = err && err.status
    if (status === 401 || status === 403) return prefix + '：需要 Songloft 管理员权限'
    if (status === 404) return prefix + '：当前 Songloft 版本不支持该功能'
    return prefix + '：' + errorMessage(err)
  }

  function renderUpdatePanel() {
    var update = state.update
    var current = $('#update-current')
    if (current) current.textContent = update.currentVersion ? 'v' + update.currentVersion : 'v—'

    var latest = $('#update-latest')
    if (latest) {
      var showLatest = update.checked && update.hasUpdate && update.latestVersion
      latest.className = showLatest ? 'chip ok' : 'chip hidden'
      latest.textContent = showLatest ? '可更新至 v' + update.latestVersion : ''
    }

    var autoToggle = $('#update-auto-toggle')
    if (autoToggle) {
      if (update.autoUpdate === null) {
        autoToggle.checked = false
        autoToggle.disabled = true
      } else {
        autoToggle.checked = !!update.autoUpdate
        autoToggle.disabled = update.autoSaving || update.loading || update.applying
      }
    }
    var autoText = $('#update-auto-text')
    if (autoText) {
      autoText.textContent = update.autoUpdate === null
        ? update.loading
          ? '读取中…'
          : '不可用'
        : update.autoSaving
          ? '保存中…'
          : update.autoUpdate
            ? '已开启'
            : '已关闭'
    }
    var autoHint = $('#update-auto-hint')
    if (autoHint) {
      autoHint.textContent = update.autoError || UPDATE_AUTO_HINT
      autoHint.classList.toggle('error-text', !!update.autoError)
    }

    var checkBtn = $('#update-check-btn')
    if (checkBtn) {
      checkBtn.disabled = !update.pluginId || update.loading || update.requesting || update.applying
      checkBtn.classList.toggle('is-loading', update.requesting)
    }
    var checkText = $('#update-check-text')
    if (checkText) checkText.textContent = update.requesting ? '检查中…' : '检查更新'

    var applyBtn = $('#update-apply-btn')
    if (applyBtn) {
      applyBtn.classList.toggle('hidden', !update.hasUpdate)
      applyBtn.disabled = update.applying || update.loading || update.requesting
    }
    var applyText = $('#update-apply-text')
    if (applyText) {
      applyText.textContent = update.applying
        ? '正在更新…'
        : update.latestVersion
          ? '更新到 v' + update.latestVersion
          : '立即更新'
    }

    var status = $('#update-status')
    if (status) {
      status.textContent = update.status || (update.loading ? '正在读取插件信息…' : '')
      status.className = 'update-status' + (update.statusKind ? ' ' + update.statusKind : '')
    }
  }

  async function loadUpdatePanel(force) {
    var update = state.update
    if (update.loading || update.applying) return
    if (update.loaded && !force) {
      renderUpdatePanel()
      return
    }
    update.loading = true
    update.autoError = ''
    update.status = force ? '正在刷新插件信息…' : '正在读取插件信息…'
    update.statusKind = 'busy'
    renderUpdatePanel()
    try {
      var plugin = await fetchHostPlugin()
      update.pluginId = Number(plugin.id) || 0
      update.currentVersion = String(plugin.version || '')
      update.loaded = true

      try {
        var setting = await hostApi('/api/v1/settings/plugin-auto-update')
        update.autoUpdate = !!(setting && setting.enabled)
      } catch (settingErr) {
        update.autoUpdate = null
        update.autoError = updateErrorMessage(settingErr, '自动更新开关不可用')
      }
      update.loading = false
      renderUpdatePanel()
      await checkPluginUpdate(false)
    } catch (err) {
      update.loaded = false
      update.pluginId = 0
      update.status = updateErrorMessage(err, '读取插件信息失败')
      update.statusKind = 'error'
      if (force) toast(update.status, 'error')
    } finally {
      update.loading = false
      renderUpdatePanel()
    }
  }

  async function checkPluginUpdate(manual) {
    var update = state.update
    if (!update.pluginId || update.requesting || update.applying) return
    update.requesting = true
    if (manual) {
      update.status = '正在检查更新…'
      update.statusKind = 'busy'
      renderUpdatePanel()
    }
    try {
      var info = await hostApi('/api/v1/jsplugins/' + encodeURIComponent(String(update.pluginId)) + '/check-update')
      update.currentVersion = String((info && info.current_version) || update.currentVersion || '')
      update.latestVersion = String((info && info.remote_version) || '')
      update.hasUpdate = !!(info && info.has_update)
      update.checked = true
      update.status = update.hasUpdate
        ? '发现新版本 v' + update.latestVersion + '，可立即更新。'
        : '当前已是最新版本。'
      update.statusKind = update.hasUpdate ? 'ok' : ''
      if (manual) {
        toast(update.hasUpdate ? '发现新版本 v' + update.latestVersion : '当前已是最新版本')
      }
    } catch (err) {
      update.checked = false
      update.hasUpdate = false
      update.latestVersion = ''
      update.status = updateErrorMessage(err, '检查更新失败')
      update.statusKind = 'error'
      if (manual) toast(update.status, 'error')
    } finally {
      update.requesting = false
      renderUpdatePanel()
    }
  }

  async function toggleAutoUpdate(input) {
    var update = state.update
    var enabled = !!(input && input.checked)
    if (update.autoSaving) return
    update.autoSaving = true
    update.autoError = ''
    update.status = '正在保存自动更新设置…'
    update.statusKind = 'busy'
    renderUpdatePanel()
    try {
      var result = await hostApi('/api/v1/settings/plugin-auto-update', {
        method: 'PUT',
        body: JSON.stringify({ enabled: enabled }),
      })
      update.autoUpdate = !!(result && result.enabled)
      update.status = update.autoUpdate
        ? 'Songloft 自动更新已开启，后台会定时检查并更新插件。'
        : 'Songloft 自动更新已关闭。'
      update.statusKind = 'ok'
      toast(update.autoUpdate ? '已开启 Songloft 自动更新' : '已关闭 Songloft 自动更新')
    } catch (err) {
      update.autoUpdate = !enabled
      update.autoError = updateErrorMessage(err, '保存自动更新设置失败')
      update.status = update.autoError
      update.statusKind = 'error'
      toast(update.status, 'error')
    } finally {
      update.autoSaving = false
      renderUpdatePanel()
    }
  }

  async function fetchInstalledVersion() {
    try {
      var plugin = await fetchHostPlugin()
      return String((plugin && plugin.version) || '')
    } catch (err) {
      return ''
    }
  }

  function reloadAfterUpdate() {
    try {
      var url = new URL(window.location.href)
      url.searchParams.set('_updated', String(Date.now()))
      window.location.replace(url.toString())
    } catch (err) {
      window.location.reload()
    }
  }

  async function applyPluginUpdate() {
    var update = state.update
    if (!update.pluginId || !update.hasUpdate || update.applying) return
    var target = update.latestVersion || '新版本'
    var previousVersion = update.currentVersion
    var confirmed = await askConfirm(
      '安装插件更新',
      '将从远程下载 v' + target + ' 并自动热重载插件。更新完成后页面会自动刷新。',
      '立即更新'
    )
    if (!confirmed) return

    update.applying = true
    update.status = '正在下载并安装 v' + target + '…'
    update.statusKind = 'busy'
    renderUpdatePanel()
    try {
      await hostApi('/api/v1/jsplugins/' + encodeURIComponent(String(update.pluginId)) + '/update', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      update.status = '更新完成，正在重新加载…'
      update.statusKind = 'ok'
      update.hasUpdate = false
      renderUpdatePanel()
      toast('插件已更新，即将刷新页面')
      setTimeout(reloadAfterUpdate, 1200)
    } catch (err) {
      // 热重载可能让请求在服务端完成后断开；查一次版本确认是否已经生效。
      await new Promise(function (resolve) { setTimeout(resolve, 800) })
      var installed = await fetchInstalledVersion()
      if (installed && installed !== previousVersion) {
        update.currentVersion = installed
        update.status = '更新完成，正在重新加载…'
        update.statusKind = 'ok'
        update.hasUpdate = false
        renderUpdatePanel()
        toast('插件已更新，即将刷新页面')
        setTimeout(reloadAfterUpdate, 1200)
        return
      }
      update.status = updateErrorMessage(err, '更新失败')
      update.statusKind = 'error'
      toast(update.status, 'error')
    } finally {
      update.applying = false
      renderUpdatePanel()
    }
  }

  /* ================= 播放链接弹窗 ================= */

  var urlDialogSeq = 0

  async function openUrlDialog(song) {
    var dialog = $('#url-dialog')
    if (!dialog) return
    var seq = ++urlDialogSeq
    var meta = $('#url-meta')
    var text = $('#url-text')
    var headersBox = $('#url-headers-box')
    var headersPre = $('#url-headers')
    if (meta) meta.textContent = [song.title, song.artist, platformShort(song.platform)].filter(Boolean).join(' · ')
    if (text) text.value = '正在解析…'
    if (headersBox) headersBox.hidden = true
    if (headersPre) headersPre.textContent = ''
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }

    try {
      var data = null
      if (song.id) {
        data = {
          url: withToken(HOST_API + '/songs/' + encodeURIComponent(song.id) + '/play'),
          quality: 'original',
          source_name: song.isLocal ? '本地曲库' : '宿主流媒体',
          headers: {},
        }
      } else {
        if (!song.source_data) throw new Error('缺少音源信息')
        var result = await api('direct/music/url', {
          method: 'POST',
          body: JSON.stringify({ source_data: song.source_data }),
        })
        if (seq !== urlDialogSeq) return
        data = result.data || {}
      }
      if (!data.url) throw new Error('音源没有返回播放链接')
      if (meta) {
        meta.textContent =
          [song.title, song.artist, qualityLabel(data.quality), data.source_name].filter(Boolean).join(' · ')
      }
      if (text) text.value = absoluteUrl(data.url)
      var headers = data.headers && Object.keys(data.headers).length ? data.headers : null
      if (headersBox) headersBox.hidden = !headers
      if (headersPre) headersPre.textContent = headers ? JSON.stringify(headers, null, 2) : ''
    } catch (err) {
      if (seq !== urlDialogSeq) return
      if (text) text.value = ''
      if (meta) meta.textContent = '解析失败：' + errorMessage(err)
    }
  }

  function closeUrlDialog() {
    urlDialogSeq++
    var dialog = $('#url-dialog')
    if (!dialog) return
    if (typeof dialog.close === 'function') dialog.close()
    else dialog.removeAttribute('open')
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
    var area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    var ok = false
    try {
      ok = document.execCommand('copy')
    } catch (err) {
      ok = false
    }
    document.body.removeChild(area)
    if (!ok) throw new Error('浏览器不允许自动复制，请手动选择文本')
  }

  /* ================= 播放器 ================= */

  var audio = null
  var playerState = {
    queue: [],
    index: -1,
    mode: 'sequence',
    volume: 0.8,
    loading: false,
    resolvedUrl: '',
    triedProxy: false,
    loadedKey: '',
    collapsed: false,
  }

  var PLAY_MODES = [
    { id: 'sequence', icon: 'repeat', title: '列表循环' },
    { id: 'singleLoop', icon: 'repeat-one', title: '单曲循环' },
    { id: 'random', icon: 'shuffle', title: '随机播放' },
    { id: 'singlePlay', icon: 'arrow-right', title: '顺序播放' },
  ]

  function currentSong() {
    return playerState.index >= 0 && playerState.index < playerState.queue.length ? playerState.queue[playerState.index] : null
  }

  function playModeInfo() {
    for (var i = 0; i < PLAY_MODES.length; i++) {
      if (PLAY_MODES[i].id === playerState.mode) return PLAY_MODES[i]
    }
    return PLAY_MODES[0]
  }

  function updatePlayIcon() {
    var button = $('#player-toggle')
    if (!button) return
    var use = button.querySelector('use')
    if (use) use.setAttribute('href', audio && !audio.paused ? '#i-pause' : '#i-play')
    button.title = audio && !audio.paused ? '暂停' : '播放'
    button.classList.toggle('loading', playerState.loading)
  }

  function updateModeUI() {
    var mode = playModeInfo()
    var button = $('#player-mode')
    if (!button) return
    var use = button.querySelector('use')
    if (use) use.setAttribute('href', '#i-' + mode.icon)
    button.title = '播放模式：' + mode.title
  }

  function updateVolumeUI() {
    var range = $('#volume-range')
    if (range) range.value = String(playerState.volume)
    var button = $('#player-volume')
    if (!button) return
    var use = button.querySelector('use')
    if (use) use.setAttribute('href', playerState.volume <= 0.001 ? '#i-volume-mute' : '#i-volume')
    button.title = '音量'
  }

  function renderPlayer() {
    var song = currentSong()
    var titleButton = $('#player-title')
    var artistNode = $('#player-artist')
    if (titleButton) titleButton.textContent = song ? song.title || '未知歌曲' : '洛雪音乐'
    if (artistNode) artistNode.textContent = song ? song.artist || '未知歌手' : '听你想听'
    var cover = $('#player-cover')
    if (cover) {
      appendCover(cover, song ? song.cover_url : '')
      if (!cover.querySelector('img') && !cover.querySelector('.icon')) cover.appendChild(svgIcon('music'))
    }
    var queueTotal = $('#queue-total')
    if (queueTotal) queueTotal.textContent = String(playerState.queue.length)
    updatePlayIcon()
    updateModeUI()
    updateVolumeUI()
    var progress = $('#player-track')
    if (progress && !song) {
      progress.setAttribute('aria-valuenow', '0')
    }
    var current = $('#player-current')
    var duration = $('#player-duration')
    if (!song) {
      if (current) current.textContent = '00:00'
      if (duration) duration.textContent = '00:00'
      var fill = $('#player-fill')
      if (fill) fill.style.width = '0%'
      var thumb = $('#player-thumb')
      if (thumb) thumb.style.left = '0%'
    } else if (playerState.loadedKey !== songKey(song)) {
      if (current) current.textContent = '00:00'
      if (duration) duration.textContent = song.duration ? formatDuration(song.duration) : '00:00'
      var resetFill = $('#player-fill')
      if (resetFill) resetFill.style.width = '0%'
      var resetThumb = $('#player-thumb')
      if (resetThumb) resetThumb.style.left = '0%'
    }
    updateMediaSession(song)
  }

  function updateMediaSession(song) {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return
    try {
      if (song) {
        var artwork = []
        var cover = imageUrl(song.cover_url)
        if (cover) artwork.push({ src: cover })
        navigator.mediaSession.metadata = new MediaMetadata({
          title: song.title || '未知歌曲',
          artist: song.artist || '未知歌手',
          album: song.album || '',
          artwork: artwork,
        })
      } else {
        navigator.mediaSession.metadata = null
      }
    } catch (err) {
      /* ignore */
    }
  }

  function updateMediaSessionState() {
    if (!('mediaSession' in navigator) || !audio) return
    try {
      navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'
    } catch (err) {
      /* ignore */
    }
  }

  function renderQueue() {
    var list = $('#queue-list')
    var empty = $('#queue-empty')
    var total = $('#queue-total')
    if (total) total.textContent = String(playerState.queue.length)
    if (!list) return
    list.innerHTML = ''
    if (!playerState.queue.length) {
      if (empty) empty.classList.remove('hidden')
      return
    }
    if (empty) empty.classList.add('hidden')
    playerState.queue.forEach(function (song, index) {
      var row = el('li', 'queue-row' + (index === playerState.index ? ' playing' : ''))
      row.appendChild(el('span', 'queue-index', String(index + 1)))
      var main = el('div', 'queue-main')
      main.appendChild(el('div', 'queue-title', song.title || '未知歌曲'))
      main.appendChild(el('div', 'queue-sub', [song.artist || '未知歌手', platformShort(song.platform)].filter(Boolean).join(' · ')))
      row.appendChild(main)
      row.appendChild(el('span', 'queue-duration', formatDuration(song.duration)))
      var remove = el('button', 'action-btn')
      remove.type = 'button'
      remove.title = '从播放列表移除'
      remove.appendChild(svgIcon('close'))
      remove.addEventListener('click', function (event) {
        event.stopPropagation()
        removeFromQueue(index)
      })
      row.appendChild(remove)
      row.addEventListener('click', function () {
        playerState.index = index
        renderQueue()
        loadCurrentAndPlay()
      })
      list.appendChild(row)
    })
  }

  function savePlayer() {
    try {
      var payload = {
        queue: playerState.queue.slice(0, 200),
        index: playerState.index,
        mode: playerState.mode,
        volume: playerState.volume,
        collapsed: playerState.collapsed,
      }
      localStorage.setItem(LS_PLAYER, JSON.stringify(payload))
    } catch (err) {
      /* ignore */
    }
  }

  function restorePlayer() {
    try {
      var raw = localStorage.getItem(LS_PLAYER)
      if (!raw) return
      var saved = JSON.parse(raw)
      if (!saved || typeof saved !== 'object') return
      if (Array.isArray(saved.queue)) playerState.queue = saved.queue
      playerState.index = Number(saved.index)
      if (!isFinite(playerState.index) || playerState.index < 0 || playerState.index >= playerState.queue.length) {
        playerState.index = playerState.queue.length ? 0 : -1
      }
      var validMode = false
      PLAY_MODES.forEach(function (mode) {
        if (mode.id === saved.mode) validMode = true
      })
      if (validMode) playerState.mode = saved.mode
      var volume = Number(saved.volume)
      if (isFinite(volume) && volume >= 0 && volume <= 1) playerState.volume = volume
      playerState.collapsed = !!saved.collapsed
      if (audio) audio.volume = playerState.volume
      var player = $('#player')
      if (player) player.classList.toggle('collapsed', playerState.collapsed)
    } catch (err) {
      /* ignore */
    }
  }

  function resolveSongUrl(song) {
    if (song.id) return Promise.resolve(withToken(HOST_API + '/songs/' + encodeURIComponent(song.id) + '/play'))
    if (!song.source_data) return Promise.reject(new Error('缺少音源信息，无法解析播放链接'))
    return api('direct/music/url', {
      method: 'POST',
      body: JSON.stringify({ source_data: song.source_data }),
    }).then(function (result) {
      var data = result.data || {}
      if (!data.url) throw new Error('音源没有返回播放链接')
      return data.url
    })
  }

  function setPlayerLoading(loading) {
    playerState.loading = loading
    updatePlayIcon()
  }

  async function loadCurrentAndPlay() {
    var song = currentSong()
    if (!song) return
    if (!audio) return
    var key = songKey(song)
    playerState.resolvedUrl = ''
    playerState.triedProxy = false
    playerState.loadedKey = ''
    setPlayerLoading(true)
    renderPlayer()
    try {
      var url = await resolveSongUrl(song)
      var still = currentSong()
      if (!still || songKey(still) !== key) return
      playerState.resolvedUrl = url
      playerState.loadedKey = key
      audio.src = url
      audio.volume = playerState.volume
      var playPromise = audio.play()
      if (playPromise && typeof playPromise.catch === 'function') {
        await playPromise.catch(function (err) {
          if (err && err.name === 'AbortError') return
          throw err
        })
      }
    } catch (err) {
      setPlayerLoading(false)
      updatePlayIcon()
      toast('播放失败：' + errorMessage(err) + '，可点击「链接」按钮复制播放地址', 'error')
    }
  }

  function togglePlay() {
    if (!audio) return
    var song = currentSong()
    if (!song) {
      if (playerState.queue.length) {
        playerState.index = 0
        loadCurrentAndPlay()
      } else {
        toast('播放列表是空的，先搜索或从曲库选择歌曲')
      }
      return
    }
    if (audio.paused) {
      if (!audio.src || playerState.loadedKey !== songKey(song)) {
        loadCurrentAndPlay()
      } else {
        var promise = audio.play()
        if (promise && typeof promise.catch === 'function') {
          promise.catch(function (err) {
            toast('播放失败：' + errorMessage(err), 'error')
          })
        }
      }
    } else {
      audio.pause()
    }
  }

  function playNext(auto) {
    if (!playerState.queue.length) return
    if (auto && playerState.mode === 'singleLoop') {
      audio.currentTime = 0
      var repeatPromise = audio.play()
      if (repeatPromise && typeof repeatPromise.catch === 'function') repeatPromise.catch(function () {})
      return
    }
    var nextIndex
    if (playerState.mode === 'random') {
      if (playerState.queue.length <= 1) nextIndex = playerState.index
      else {
        do {
          nextIndex = Math.floor(Math.random() * playerState.queue.length)
        } while (nextIndex === playerState.index)
      }
    } else {
      nextIndex = playerState.index + 1
      if (nextIndex >= playerState.queue.length) {
        if (playerState.mode === 'singlePlay') {
          audio.pause()
          audio.currentTime = 0
          updatePlayIcon()
          return
        }
        nextIndex = 0
      }
    }
    playerState.index = nextIndex
    renderQueue()
    loadCurrentAndPlay()
  }

  function playPrev() {
    if (!playerState.queue.length) return
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    var prevIndex = playerState.index - 1
    if (prevIndex < 0) prevIndex = playerState.queue.length - 1
    playerState.index = prevIndex
    renderQueue()
    loadCurrentAndPlay()
  }

  function enqueueSong(song) {
    var key = songKey(song)
    var exists = playerState.queue.some(function (item) {
      return songKey(item) === key
    })
    if (!exists) {
      playerState.queue.push(song)
      if (playerState.index < 0) playerState.index = 0
      renderQueue()
      renderPlayer()
      savePlayer()
    }
  }

  function removeFromQueue(index) {
    if (index < 0 || index >= playerState.queue.length) return
    var wasCurrent = index === playerState.index
    playerState.queue.splice(index, 1)
    if (!playerState.queue.length) {
      playerState.index = -1
      if (audio) {
        audio.pause()
        audio.removeAttribute('src')
      }
    } else if (index < playerState.index) {
      playerState.index -= 1
    } else if (wasCurrent) {
      if (playerState.index >= playerState.queue.length) playerState.index = playerState.queue.length - 1
      loadCurrentAndPlay()
    }
    renderQueue()
    renderPlayer()
    savePlayer()
  }

  function clearQueue() {
    playerState.queue = []
    playerState.index = -1
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
    }
    renderQueue()
    renderPlayer()
    savePlayer()
  }

  function cycleMode() {
    var index = 0
    for (var i = 0; i < PLAY_MODES.length; i++) {
      if (PLAY_MODES[i].id === playerState.mode) {
        index = i
        break
      }
    }
    playerState.mode = PLAY_MODES[(index + 1) % PLAY_MODES.length].id
    updateModeUI()
    savePlayer()
    toast('播放模式：' + playModeInfo().title)
  }

  function updateProgress() {
    var song = currentSong()
    var duration = (audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0) || (song ? song.duration : 0) || 0
    var current = audio ? audio.currentTime || 0 : 0
    var ratio = duration > 0 ? Math.min(1, current / duration) : 0
    var fill = $('#player-fill')
    var thumb = $('#player-thumb')
    var track = $('#player-track')
    var currentLabel = $('#player-current')
    var durationLabel = $('#player-duration')
    if (fill) fill.style.width = (ratio * 100).toFixed(2) + '%'
    if (thumb) thumb.style.left = (ratio * 100).toFixed(2) + '%'
    if (currentLabel) currentLabel.textContent = current > 0 ? formatDuration(current) : '00:00'
    if (durationLabel) durationLabel.textContent = duration > 0 ? formatDuration(duration) : '00:00'
    if (track) track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }

  function seekToRatio(ratio) {
    if (!audio) return
    var duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
    if (!duration) return
    audio.currentTime = Math.max(0, Math.min(duration, duration * ratio))
    updateProgress()
  }

  function initPlayerEvents() {
    audio = $('#audio')
    if (audio) {
      audio.volume = playerState.volume
      audio.addEventListener('loadedmetadata', function () {
        updateProgress()
      })
      audio.addEventListener('timeupdate', function () {
        if (!playerState.dragging) updateProgress()
      })
      audio.addEventListener('durationchange', updateProgress)
      audio.addEventListener('play', function () {
        setPlayerLoading(false)
        updatePlayIcon()
        updateMediaSessionState()
      })
      audio.addEventListener('playing', function () {
        setPlayerLoading(false)
        updatePlayIcon()
      })
      audio.addEventListener('pause', function () {
        updatePlayIcon()
        updateMediaSessionState()
      })
      audio.addEventListener('waiting', function () {
        setPlayerLoading(true)
      })
      audio.addEventListener('ended', function () {
        playNext(true)
      })
      audio.addEventListener('error', function () {
        var song = currentSong()
        var url = playerState.resolvedUrl
        if (song && url && !playerState.triedProxy && /^http:/.test(url) && window.location.protocol === 'https:') {
          playerState.triedProxy = true
          audio.src = withToken(HOST_API + '/proxy?url=' + encodeURIComponent(url))
          var promise = audio.play()
          if (promise && typeof promise.catch === 'function') promise.catch(function () {})
          return
        }
        setPlayerLoading(false)
        updatePlayIcon()
        if (song) toast('音频加载失败，可能是音源链接失效或需要请求头；可点击「链接」复制地址用外部播放器打开', 'error')
      })
      audio.addEventListener('volumechange', function () {
        playerState.volume = audio.volume
        updateVolumeUI()
        savePlayer()
      })
    }

    var toggle = $('#player-toggle')
    if (toggle) toggle.addEventListener('click', togglePlay)
    var prev = $('#player-prev')
    if (prev) prev.addEventListener('click', playPrev)
    var next = $('#player-next')
    if (next) next.addEventListener('click', function () {
      playNext(false)
    })
    var mode = $('#player-mode')
    if (mode) mode.addEventListener('click', cycleMode)
    var queueButton = $('#player-queue-btn')
    if (queueButton) {
      queueButton.addEventListener('click', function () {
        toggleQueueDrawer()
      })
    }
    var title = $('#player-title')
    if (title) title.addEventListener('click', toggleQueueDrawer)
    var volumeButton = $('#player-volume')
    if (volumeButton) {
      volumeButton.addEventListener('click', function (event) {
        event.stopPropagation()
        var pop = $('#volume-pop')
        if (pop) pop.classList.toggle('hidden')
      })
    }
    var collapse = $('#player-collapse')
    if (collapse) {
      collapse.addEventListener('click', function () {
        playerState.collapsed = !playerState.collapsed
        var player = $('#player')
        if (player) player.classList.toggle('collapsed', playerState.collapsed)
        var pop = $('#volume-pop')
        if (pop) pop.classList.add('hidden')
        savePlayer()
      })
    }

    var track = $('#player-track')
    if (track) {
      function ratioFromEvent(event) {
        var rect = track.getBoundingClientRect()
        if (!rect.width) return 0
        return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      }
      track.addEventListener('pointerdown', function (event) {
        playerState.dragging = true
        track.classList.add('dragging')
        track.setPointerCapture && track.setPointerCapture(event.pointerId)
        seekToRatio(ratioFromEvent(event))
      })
      track.addEventListener('pointermove', function (event) {
        if (!playerState.dragging) return
        seekToRatio(ratioFromEvent(event))
      })
      function endDrag() {
        playerState.dragging = false
        track.classList.remove('dragging')
      }
      track.addEventListener('pointerup', endDrag)
      track.addEventListener('pointercancel', endDrag)
      track.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          audio.currentTime = Math.max(0, audio.currentTime - 5)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5)
        }
      })
    }

    var volumeRange = $('#volume-range')
    if (volumeRange) {
      volumeRange.addEventListener('input', function () {
        if (audio) audio.volume = Number(volumeRange.value)
      })
    }

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', function () {
          if (audio) {
            var promise = audio.play()
            if (promise && typeof promise.catch === 'function') promise.catch(function () {})
          }
        })
        navigator.mediaSession.setActionHandler('pause', function () {
          if (audio) audio.pause()
        })
        navigator.mediaSession.setActionHandler('previoustrack', playPrev)
        navigator.mediaSession.setActionHandler('nexttrack', function () {
          playNext(false)
        })
      } catch (err) {
        /* ignore */
      }
    }

    document.addEventListener('keydown', function (event) {
      var target = event.target
      if (target && target.closest && target.closest('input, textarea, select, button, [contenteditable="true"]')) return
      if (event.code === 'Space') {
        event.preventDefault()
        togglePlay()
      } else if (event.code === 'ArrowLeft' && audio && audio.src) {
        event.preventDefault()
        audio.currentTime = Math.max(0, audio.currentTime - 5)
      } else if (event.code === 'ArrowRight' && audio && audio.src) {
        event.preventDefault()
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5)
      }
    })
  }

  function toggleQueueDrawer() {
    var drawer = $('#queue-drawer')
    if (!drawer) return
    drawer.classList.toggle('hidden')
    if (!drawer.classList.contains('hidden')) renderQueue()
  }

  function closeQueueDrawer() {
    var drawer = $('#queue-drawer')
    if (drawer) drawer.classList.add('hidden')
  }

  /* ================= 播放入口（供各页面使用） ================= */

  function playSongs(songs, startIndex) {
    if (!songs || !songs.length) return
    playerState.queue = songs.slice()
    playerState.index = Math.max(0, Math.min(startIndex || 0, songs.length - 1))
    renderQueue()
    renderPlayer()
    savePlayer()
    loadCurrentAndPlay()
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    $all('.nav-item').forEach(function (button) {
      button.addEventListener('click', function () {
        navigate(button.getAttribute('data-route'))
      })
    })
    var themeToggle = $('#theme-toggle')
    if (themeToggle) themeToggle.addEventListener('click', toggleTheme)
    var sidebarToggle = $('#sidebar-toggle')
    if (sidebarToggle) sidebarToggle.addEventListener('click', openSidebar)
    var backdrop = $('#sidebar-backdrop')
    if (backdrop) backdrop.addEventListener('click', closeSidebar)

    var pageRefresh = $('#page-refresh')
    if (pageRefresh) pageRefresh.addEventListener('click', refreshCurrentPage)

    // 搜索
    var searchButton = $('#search-btn')
    if (searchButton) searchButton.addEventListener('click', function () { performSearch(true) })
    var searchInput = $('#search-input')
    if (searchInput) {
      searchInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault()
          performSearch(true)
        }
      })
    }
    var searchPlatform = $('#search-platform')
    if (searchPlatform) searchPlatform.addEventListener('change', function () { loadHot(true) })
    var searchQuality = $('#search-quality')
    if (searchQuality) {
      searchQuality.addEventListener('change', function () {
        state.search.quality = searchQuality.value
      })
    }
    var hotRefresh = $('#hot-refresh')
    if (hotRefresh) hotRefresh.addEventListener('click', function () { loadHot(true) })
    var loadMore = $('#load-more')
    if (loadMore) loadMore.addEventListener('click', function () { performSearch(false) })
    var selectAll = $('#select-all')
    if (selectAll) {
      selectAll.addEventListener('change', function () {
        state.search.selected.clear()
        if (selectAll.checked) {
          state.search.songs.forEach(function (song) {
            state.search.selected.add(songKey(song))
          })
        }
        renderSearchResults()
      })
    }
    var importSelected = $('#import-selected')
    if (importSelected) importSelected.addEventListener('click', importSelectedSongs)

    // 歌单
    var songlistPlatform = $('#songlist-platform')
    if (songlistPlatform) {
      songlistPlatform.addEventListener('change', function () {
        state.songlist.tagsLoaded = false
        state.songlist.tagsData = null
        state.songlist.keyword = ''
        state.songlist.tagId = ''
        state.songlist.page = 1
        var input = $('#songlist-search')
        if (input) input.value = ''
        $('#songlist-browse').classList.remove('hidden')
        $('#songlist-detail').classList.add('hidden')
        loadSonglistMeta().then(function () { loadSonglistPage(1, true) })
      })
    }
    var songlistSort = $('#songlist-sort')
    if (songlistSort) {
      songlistSort.addEventListener('change', function () {
        state.songlist.sortId = songlistSort.value
        clearSonglistKeyword()
        loadSonglistPage(1, true)
      })
    }
    var songlistSearch = $('#songlist-search')
    if (songlistSearch) {
      songlistSearch.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault()
          startSonglistSearch()
        }
      })
    }
    var songlistSearchBtn = $('#songlist-search-btn')
    if (songlistSearchBtn) {
      songlistSearchBtn.addEventListener('click', startSonglistSearch)
    }
    var songlistPrev = $('#songlist-prev')
    if (songlistPrev) {
      songlistPrev.addEventListener('click', function () {
        if (state.songlist.page > 1) loadSonglistPage(state.songlist.page - 1, true)
      })
    }
    var songlistNext = $('#songlist-next')
    if (songlistNext) {
      songlistNext.addEventListener('click', function () {
        if (state.songlist.hasMore) loadSonglistPage(state.songlist.page + 1, true)
      })
    }
    var songlistBack = $('#songlist-back')
    if (songlistBack) {
      songlistBack.addEventListener('click', function () {
        $('#songlist-detail').classList.add('hidden')
        $('#songlist-browse').classList.remove('hidden')
      })
    }
    var songlistPlayAll = $('#songlist-play-all')
    if (songlistPlayAll) {
      songlistPlayAll.addEventListener('click', function () {
        if (state.songlist.detailSongs.length) playSongs(state.songlist.detailSongs, 0)
        else toast('歌单还没有加载到歌曲')
      })
    }
    var songlistImportAll = $('#songlist-import-all')
    if (songlistImportAll) {
      songlistImportAll.addEventListener('click', function () {
        importSongs(state.songlist.detailSongs, '', songlistImportAll)
      })
    }
    var songlistDetailMore = $('#songlist-detail-more')
    if (songlistDetailMore) {
      songlistDetailMore.addEventListener('click', function () {
        if (state.songlist.detailHasMore) loadSonglistDetail(state.songlist.detailPage + 1, false)
      })
    }

    // 排行榜
    var leaderboardPlatform = $('#leaderboard-platform')
    if (leaderboardPlatform) {
      leaderboardPlatform.addEventListener('change', function () {
        state.leaderboard.platform = leaderboardPlatform.value
        state.leaderboard.activeBoard = null
        state.leaderboard.boards = []
        state.leaderboard.songs = []
        renderBoards()
        renderBoardSongs()
        loadBoards()
      })
    }
    var leaderboardRefresh = $('#leaderboard-refresh')
    if (leaderboardRefresh) leaderboardRefresh.addEventListener('click', loadBoards)
    var leaderboardPlayAll = $('#leaderboard-play-all')
    if (leaderboardPlayAll) {
      leaderboardPlayAll.addEventListener('click', function () {
        if (state.leaderboard.songs.length) playSongs(state.leaderboard.songs, 0)
        else toast('榜单还没有加载到歌曲')
      })
    }
    var boardMore = $('#board-more')
    if (boardMore) {
      boardMore.addEventListener('click', function () {
        if (state.leaderboard.hasMore) loadBoardSongs(state.leaderboard.page + 1, false)
      })
    }

    // 本地
    $all('.view-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchLocalView(tab.getAttribute('data-local-view'))
      })
    })
    var localSearch = $('#local-search')
    if (localSearch) {
      localSearch.addEventListener('input', function () {
        state.local.keyword = localSearch.value
        if (state.local.view === 'songs') renderLocalSongs()
        else renderLocalPlaylists()
      })
    }
    var localRefresh = $('#local-refresh')
    if (localRefresh) {
      localRefresh.addEventListener('click', function () {
        if (state.local.detail && !$('#local-playlist-detail').classList.contains('hidden')) {
          openLocalPlaylist(state.local.detail)
        } else if (state.local.view === 'songs') {
          loadLocalSongs(true)
        } else {
          loadLocalPlaylists()
        }
      })
    }
    var localMore = $('#local-more')
    if (localMore) {
      localMore.addEventListener('click', function () {
        if (state.local.hasMore) loadLocalSongs(false)
      })
    }
    var localPlaylistBack = $('#local-playlist-back')
    if (localPlaylistBack) {
      localPlaylistBack.addEventListener('click', function () {
        state.local.detail = null
        $('#local-playlist-detail').classList.add('hidden')
        if (state.local.view === 'songs') $('#local-songs-view').classList.remove('hidden')
        else $('#local-playlists-view').classList.remove('hidden')
      })
    }
    var localPlaylistPlay = $('#local-playlist-play')
    if (localPlaylistPlay) {
      localPlaylistPlay.addEventListener('click', function () {
        if (state.local.detailSongs.length) playSongs(state.local.detailSongs, 0)
        else toast('歌单还没有歌曲')
      })
    }

    // 设置
    var sourcesRefresh = $('#sources-refresh')
    if (sourcesRefresh) sourcesRefresh.addEventListener('click', function () { refreshSources(false) })
    var dropZone = $('#drop-zone')
    var fileInput = $('#source-file-input')
    if (dropZone && fileInput) {
      dropZone.addEventListener('click', function () { fileInput.click() })
      dropZone.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          fileInput.click()
        }
      })
      fileInput.addEventListener('click', function (event) {
        event.stopPropagation()
      })
      fileInput.addEventListener('change', function () {
        addImportFiles(fileInput.files)
        fileInput.value = ''
      })
      ;['dragenter', 'dragover'].forEach(function (name) {
        dropZone.addEventListener(name, function (event) {
          event.preventDefault()
          event.stopPropagation()
          dropZone.classList.add('dragover')
        })
      })
      ;['dragleave', 'drop'].forEach(function (name) {
        dropZone.addEventListener(name, function (event) {
          event.preventDefault()
          event.stopPropagation()
          dropZone.classList.remove('dragover')
        })
      })
      dropZone.addEventListener('drop', function (event) {
        if (event.dataTransfer && event.dataTransfer.files) addImportFiles(event.dataTransfer.files)
      })
      ;['dragover', 'drop'].forEach(function (name) {
        document.addEventListener(name, function (event) {
          event.preventDefault()
        })
      })
    }
    var importFilesButton = $('#import-files-btn')
    if (importFilesButton) importFilesButton.addEventListener('click', uploadSourceFiles)
    var importUrlButton = $('#import-url-btn')
    if (importUrlButton) importUrlButton.addEventListener('click', importSourceUrl)
    var sourceUrlInput = $('#source-url-input')
    if (sourceUrlInput) {
      sourceUrlInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault()
          importSourceUrl()
        }
      })
    }
    var importJsonButton = $('#import-json-btn')
    if (importJsonButton) importJsonButton.addEventListener('click', importSongsJson)
    var defaultQuality = $('#default-quality')
    if (defaultQuality) {
      defaultQuality.addEventListener('change', function () {
        changeDefaultQuality(defaultQuality.value)
      })
    }
    var hotCheckbox = $('#setting-hot')
    if (hotCheckbox) {
      hotCheckbox.addEventListener('change', function () {
        changeHotSetting(hotCheckbox.checked)
      })
    }
    var updateCheckBtn = $('#update-check-btn')
    if (updateCheckBtn) {
      updateCheckBtn.addEventListener('click', function () { checkPluginUpdate(true) })
    }
    var updateApplyBtn = $('#update-apply-btn')
    if (updateApplyBtn) updateApplyBtn.addEventListener('click', applyPluginUpdate)
    var updateAutoToggle = $('#update-auto-toggle')
    if (updateAutoToggle) {
      updateAutoToggle.addEventListener('change', function () {
        toggleAutoUpdate(updateAutoToggle)
      })
    }

    // 播放列表抽屉
    var queueClose = $('#queue-close')
    if (queueClose) queueClose.addEventListener('click', closeQueueDrawer)
    var queueClear = $('#queue-clear')
    if (queueClear) {
      queueClear.addEventListener('click', function () {
        askConfirm('清空播放列表', '确定清空当前播放列表吗？', '清空').then(function (ok) {
          if (ok) clearQueue()
        })
      })
    }

    // 链接弹窗
    var urlDialog = $('#url-dialog')
    var urlClose = $('#url-close')
    if (urlClose) urlClose.addEventListener('click', closeUrlDialog)
    if (urlDialog) {
      urlDialog.addEventListener('click', function (event) {
        if (event.target === urlDialog) closeUrlDialog()
      })
      urlDialog.addEventListener('cancel', function () {
        urlDialogSeq++
      })
    }
    var urlCopy = $('#url-copy')
    if (urlCopy) {
      urlCopy.addEventListener('click', function () {
        var text = $('#url-text')
        copyText(text ? text.value : '')
          .then(function () { toast('链接已复制') })
          .catch(function (err) { toast(errorMessage(err), 'error') })
      })
    }
    var urlOpen = $('#url-open')
    if (urlOpen) {
      urlOpen.addEventListener('click', function () {
        var text = $('#url-text')
        var url = text ? text.value : ''
        if (!url) return
        window.open(url, '_blank', 'noopener')
      })
    }

    // 确认弹窗
    var confirmOk = $('#confirm-ok')
    if (confirmOk) confirmOk.addEventListener('click', function () { resolveConfirm(true) })
    var confirmCancel = $('#confirm-cancel')
    if (confirmCancel) confirmCancel.addEventListener('click', function () { resolveConfirm(false) })
    var confirmDialog = $('#confirm-dialog')
    if (confirmDialog) {
      confirmDialog.addEventListener('cancel', function (event) {
        event.preventDefault()
        resolveConfirm(false)
      })
      confirmDialog.addEventListener('close', function () {
        if (confirmResolver) {
          var resolver = confirmResolver
          confirmResolver = null
          resolver(false)
        }
      })
    }

    document.addEventListener('click', function (event) {
      var volumePop = $('#volume-pop')
      if (volumePop && !volumePop.classList.contains('hidden')) {
        var player = $('#player')
        if (player && !player.contains(event.target)) volumePop.classList.add('hidden')
      }
    })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closeSidebar()
        closeQueueDrawer()
      }
    })
  }

  async function refreshCurrentPage() {
    var route = state.route
    if (route === 'search') {
      try {
        await loadMeta()
      } catch (err) {
        toast('读取插件信息失败：' + errorMessage(err), 'error')
      }
      await loadHot(true)
      if (state.search.keyword) await performSearch(true)
      toast('已刷新')
    } else if (route === 'songlist') {
      var detail = $('#songlist-detail')
      if (detail && !detail.classList.contains('hidden') && state.songlist.detail) {
        state.songlist.detailSongs = []
        await loadSonglistDetail(1, true)
      } else {
        state.songlist.tagsLoaded = false
        state.songlist.lists = []
        await loadSonglistMeta()
        await loadSonglistPage(1, true)
      }
    } else if (route === 'leaderboard') {
      state.leaderboard.boards = []
      state.leaderboard.songs = []
      await loadBoards()
    } else if (route === 'local') {
      if (state.local.detail && !$('#local-playlist-detail').classList.contains('hidden')) {
        await openLocalPlaylist(state.local.detail)
      } else if (state.local.view === 'songs') {
        await loadLocalSongs(true)
      } else {
        await loadLocalPlaylists()
      }
    } else if (route === 'settings') {
      await refreshSources(false)
      await loadUpdatePanel(true)
      try {
        await loadMeta()
      } catch (err) {
        /* ignore */
      }
      toast('已刷新')
    }
  }

  /* ================= 启动 ================= */

  function boot() {
    initTheme()
    bindEvents()
    initPlayerEvents()
    restorePlayer()
    renderImportFiles()
    renderSearchResults()
    renderQueue()
    renderPlayer()

    var initial = currentRouteFromHash()
    loadMeta()
      .then(function () {
        navigate(initial)
        refreshSources(true)
        if (initial === 'songlist') ensureSonglist()
        if (initial === 'leaderboard') ensureLeaderboard()
        if (initial === 'local') ensureLocal()
      })
      .catch(function (err) {
        toast('读取插件信息失败：' + errorMessage(err), 'error')
        navigate('search')
        refreshSources(true)
      })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
