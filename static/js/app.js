/* 洛雪音源插件前端（vanilla JS，由 builder 打包为 app.bundle.js）。 */
(function () {
  'use strict'

  /* ---------------- 基础工具 ---------------- */

  function $(selector, root) {
    return (root || document).querySelector(selector)
  }

  function $all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector))
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function icon(name) {
    return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>'
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0))
    if (!total) return '--:--'
    const m = Math.floor(total / 60)
    const s = total % 60
    return m + ':' + (s < 10 ? '0' + s : String(s))
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }

  function qualityLabel(value) {
    const map = { flac24bit: '母带', flac: '无损', '320k': '高品质', '128k': '标准' }
    return map[value] || value || ''
  }

  let toastTimer = null
  function toast(message, kind) {
    const bar = $('#toast')
    if (!bar) return
    bar.textContent = String(message || '')
    bar.className = 'snackbar show' + (kind ? ' ' + kind : '')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      bar.className = 'snackbar' + (kind ? ' ' + kind : '')
    }, kind === 'error' ? 6000 : 3600)
  }

  /* ---------------- 鉴权 ---------------- */

  const TOKEN_KEYS = ['songloft-auth', 'songloft_auth', 'songloft:auth', 'access_token', 'accessToken', 'token']

  function tokenFromValue(raw) {
    if (!raw) return ''
    const text = String(raw).trim()
    if (!text) return ''
    if (text.charAt(0) === '{' || text.charAt(0) === '"') {
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed === 'string') return parsed.trim()
        if (parsed && typeof parsed === 'object') {
          const value =
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
    for (let i = 0; i < TOKEN_KEYS.length; i++) {
      let raw = null
      try {
        raw = storage.getItem(TOKEN_KEYS[i])
      } catch (err) {
        raw = null
      }
      const token = tokenFromValue(raw)
      if (token) return token
    }
    return ''
  }

  let cachedToken = ''

  function getToken() {
    const injected = typeof window !== 'undefined' ? window.__SONGLOFT_AUTH__ || window.__songloftAuth__ : null
    if (injected && typeof injected === 'object') {
      const value = injected.accessToken || injected.access_token || injected.token
      if (value) return String(value)
    }
    if (cachedToken) return cachedToken
    try {
      const params = new URLSearchParams(window.location.search || '')
      const fromQuery = params.get('access_token') || params.get('token')
      if (fromQuery) {
        cachedToken = fromQuery
        return cachedToken
      }
    } catch (err) {
      /* ignore */
    }
    cachedToken = readTokenFromStorage(window.localStorage) || readTokenFromStorage(window.sessionStorage)
    return cachedToken
  }

  /* ---------------- HTTP ---------------- */

  /**
   * 调用插件内部接口。返回 { data, warning }。
   * 内部接口统一 {code,msg,data,warning}；主程序契约端点返回裸对象，原样透传。
   */
  async function api(path, options) {
    const opts = options || {}
    const headers = {}
    Object.keys(opts.headers || {}).forEach(function (key) {
      headers[key] = opts.headers[key]
    })
    const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData
    if (opts.body && !isForm && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
    const token = getToken()
    if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token

    let response
    try {
      response = await fetch(path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body,
        credentials: 'same-origin',
        cache: 'no-store',
      })
    } catch (err) {
      throw new Error('网络请求失败，请确认插件服务可用：' + ((err && err.message) || err))
    }

    const text = await response.text()
    let payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch (err) {
        payload = text
      }
    }

    if (!response.ok) {
      const message =
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

  /* ---------------- 全局状态 ---------------- */

  const state = {
    meta: null,
    platformNames: {},
    quality: '320k',
    search: {
      keyword: '',
      platform: '',
      page: 1,
      pageSize: 20,
      results: [],
      selected: {},
      selectedCount: 0,
      loading: false,
      hasMore: false,
      seq: 0,
    },
    sources: {
      items: [],
      requesting: false,
      batchLoading: false,
      batchCurrent: null,
      batchPending: [],
      pollTimer: null,
    },
    importFiles: [],
  }

  function platformName(id) {
    return state.platformNames[id] || String(id || '').toUpperCase()
  }

  function qualityOptions() {
    return (state.meta && state.meta.qualities) || ['flac24bit', 'flac', '320k', '128k']
  }

  /* ---------------- 标签页 ---------------- */

  function activateTab(name) {
    $all('.tab').forEach(function (button) {
      const active = button.getAttribute('data-tab') === name
      button.setAttribute('aria-selected', active ? 'true' : 'false')
    })
    $all('.tab-panel').forEach(function (panel) {
      panel.hidden = panel.id !== 'tab-' + name
    })
    if (name === 'sources') refreshSources(false)
    try {
      history.replaceState(null, '', '#' + name)
    } catch (err) {
      /* ignore */
    }
  }

  function initTabs() {
    $all('.tab').forEach(function (button) {
      button.addEventListener('click', function () {
        activateTab(button.getAttribute('data-tab'))
      })
    })
    let initial = 'search'
    try {
      const hash = (location.hash || '').replace('#', '')
      if (hash === 'import' || hash === 'sources') initial = hash
    } catch (err) {
      /* ignore */
    }
    activateTab(initial)
  }

  /* ---------------- 元信息 ---------------- */

  async function loadMeta() {
    try {
      const result = await api('api/meta')
      const meta = result.data || {}
      state.meta = meta
      state.quality = meta.default_quality || '320k'

      const platformSelect = $('#platform-select')
      platformSelect.innerHTML = ''
      platformSelect.appendChild(new Option('全部平台', ''))
      const platforms = Array.isArray(meta.platforms) ? meta.platforms : []
      platforms.forEach(function (platform) {
        state.platformNames[platform.id] = platform.name
        platformSelect.appendChild(new Option(platform.name, platform.id))
      })

      const qualitySelect = $('#quality-select')
      qualitySelect.innerHTML = ''
      ;(meta.qualities || qualityOptions()).forEach(function (quality) {
        qualitySelect.appendChild(new Option(qualityLabel(quality) + '（' + quality + '）', quality))
      })
      qualitySelect.value = state.quality
      refreshMetaHint()
      // 音源卡片可能先于 meta 渲染，拿到平台中文名后补一次。
      if (state.sources.items.length) renderSources()
    } catch (err) {
      toast('读取插件信息失败：' + err.message, 'error')
    }
  }

  function refreshMetaHint() {
    const select = $('#platform-select')
    const names = $all('option', select).map(function (option) {
      return option.textContent
    })
    const hint = $('.search-card .hint')
    if (hint && names.length > 1) {
      hint.textContent = '搜索聚合 ' + names.slice(1).join('、') + ' 的公开接口；播放链接由已导入的洛雪音源脚本解析。'
    }
  }

  /* ---------------- 搜索 ---------------- */

  function updateSelection() {
    const info = $('#selection-info')
    const button = $('#import-selected')
    if (info) info.textContent = '已选 ' + state.search.selectedCount + ' 首'
    if (button) button.disabled = state.search.selectedCount === 0
    const all = $('#select-all')
    if (all) {
      const total = state.search.results.length
      all.checked = total > 0 && state.search.selectedCount === total
      all.indeterminate = state.search.selectedCount > 0 && state.search.selectedCount < total
    }
  }

  function setSearchStatus(message, isError) {
    const line = $('#search-status')
    if (!line) return
    line.textContent = message || ''
    line.className = 'status-line' + (isError ? ' error' : '')
  }

  function songRow(item, index) {
    const li = el('li', 'song-row')
    li.setAttribute('data-index', String(index))
    if (state.search.selected[index]) li.classList.add('selected')

    const label = el('label', 'checkbox')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = !!state.search.selected[index]
    checkbox.setAttribute('aria-label', '选择 ' + item.title)
    checkbox.addEventListener('change', function () {
      if (checkbox.checked) state.search.selected[index] = true
      else delete state.search.selected[index]
      state.search.selectedCount = Object.keys(state.search.selected).length
      li.classList.toggle('selected', checkbox.checked)
      updateSelection()
    })
    label.appendChild(checkbox)
    li.appendChild(label)

    const coverUrl = item.cover_url && /^https?:\/\//i.test(item.cover_url) ? item.cover_url : ''
    if (coverUrl) {
      const img = document.createElement('img')
      img.className = 'cover'
      img.loading = 'lazy'
      img.alt = ''
      img.referrerPolicy = 'no-referrer'
      img.src = coverUrl
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.replaceChild(fallbackCover(), img)
      })
      li.appendChild(img)
    } else {
      li.appendChild(fallbackCover())
    }

    const main = el('div', 'song-main')
    main.appendChild(el('div', 'song-title', item.title || '未知歌曲'))
    const subParts = []
    if (item.artist) subParts.push(item.artist)
    if (item.album) subParts.push(item.album)
    main.appendChild(el('div', 'song-sub', subParts.join(' · ') || '未知歌手'))
    li.appendChild(main)

    const platform = String(item.platform || (item.source_data && item.source_data.platform) || '')
    if (platform) li.appendChild(el('span', 'chip platform', platformName(platform)))
    li.appendChild(el('span', 'duration', formatDuration(item.duration)))

    const actions = el('div', 'song-actions')
    const urlButton = el('button', 'btn text', '链接')
    urlButton.type = 'button'
    urlButton.title = '解析播放链接'
    urlButton.addEventListener('click', function () {
      resolveMusicUrl(item, urlButton)
    })
    const importButton = el('button', 'btn tonal', '导入')
    importButton.type = 'button'
    importButton.title = '导入到曲库'
    importButton.addEventListener('click', function () {
      importSongItems([item], $('#playlist-name') ? $('#playlist-name').value.trim() : '', importButton)
    })
    actions.appendChild(urlButton)
    actions.appendChild(importButton)
    li.appendChild(actions)
    return li
  }

  function fallbackCover() {
    const box = el('div', 'cover-fallback')
    box.innerHTML = icon('music')
    return box
  }

  function renderSearchResults() {
    const list = $('#search-results')
    list.innerHTML = ''
    const results = state.search.results
    if (!results.length) {
      const empty = el('li', 'empty')
      empty.innerHTML = icon('search') + '<p>输入关键词开始搜索</p>'
      list.appendChild(empty)
    } else {
      results.forEach(function (item, index) {
        list.appendChild(songRow(item, index))
      })
    }
    $('#search-toolbar').classList.toggle('hidden', results.length === 0)
    updateSelection()
    $('#load-more').classList.toggle('hidden', !state.search.hasMore)
  }

  async function doSearch(reset) {
    const inputKeyword = $('#search-input').value.trim()
    if (reset && !inputKeyword) {
      toast('请输入搜索关键词')
      $('#search-input').focus()
      return
    }
    if (state.search.loading) return

    if (reset) {
      state.search.keyword = inputKeyword
      state.search.platform = $('#platform-select').value
      state.search.page = 1
      state.search.results = []
      state.search.selected = {}
      state.search.selectedCount = 0
    }
    if (!state.search.keyword) return
    const keyword = state.search.keyword
    const platform = state.search.platform
    const quality = $('#quality-select').value || state.quality
    state.search.loading = true
    const searchButton = $('#search-btn')
    searchButton.disabled = true
    searchButton.textContent = '搜索中…'
    setSearchStatus(reset ? '正在搜索「' + keyword + '」…' : '正在加载第 ' + state.search.page + ' 页…')
    const seq = ++state.search.seq

    try {
      const result = await api('api/search', {
        method: 'POST',
        body: JSON.stringify({
          keyword: keyword,
          source_id: platform,
          quality: quality,
          page: state.search.page,
          page_size: state.search.pageSize,
        }),
      })
      if (seq !== state.search.seq) return
      const data = result.data || {}
      const items = Array.isArray(data.results) ? data.results : []
      if (reset) state.search.results = items
      else state.search.results = state.search.results.concat(items)
      state.search.hasMore = items.length >= state.search.pageSize
      state.search.page += 1
      renderSearchResults()
      if (!state.search.results.length) {
        setSearchStatus('没有找到与「' + keyword + '」相关的歌曲，换个关键词试试。')
      } else {
        setSearchStatus('共加载 ' + state.search.results.length + ' 首歌曲' + (state.search.hasMore ? '，可继续加载' : ''))
      }
    } catch (err) {
      if (seq !== state.search.seq) return
      setSearchStatus(err.message || '搜索失败', true)
    } finally {
      if (seq === state.search.seq) {
        state.search.loading = false
        searchButton.disabled = false
        searchButton.textContent = '搜索'
      }
    }
  }

  async function resolveMusicUrl(item, button) {
    const original = button.textContent
    button.disabled = true
    button.textContent = '解析中…'
    try {
      const result = await api('api/direct/music/url', {
        method: 'POST',
        body: JSON.stringify({ source_data: item.source_data }),
      })
      const data = result.data || {}
      if (!data.url) throw new Error('音源没有返回播放链接')
      showUrlDialog(item, data)
    } catch (err) {
      toast(err.message || '解析播放链接失败', 'error')
    } finally {
      button.disabled = false
      button.textContent = original
    }
  }

  function showUrlDialog(item, data) {
    const dialog = $('#url-dialog')
    $('#url-meta').textContent =
      (item.title || '') +
      (item.artist ? ' · ' + item.artist : '') +
      ' · ' +
      qualityLabel(data.quality) +
      (data.source_name ? ' · ' + data.source_name : '')
    $('#url-text').value = data.url || ''
    const headers = data.headers && Object.keys(data.headers).length ? data.headers : null
    $('#url-headers-box').hidden = !headers
    $('#url-headers').textContent = headers ? JSON.stringify(headers, null, 2) : ''
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch (err) {
      ok = false
    }
    document.body.removeChild(area)
    if (!ok) throw new Error('浏览器不允许自动复制，请手动选择文本')
  }

  /* ---------------- 导入歌曲 ---------------- */

  async function importSongItems(items, playlistName, button) {
    if (!items || !items.length) return
    const original = button ? button.innerHTML : ''
    if (button) {
      button.disabled = true
      button.textContent = '导入中…'
    }
    try {
      const songs = items.map(function (item) {
        return {
          title: item.title,
          artist: item.artist,
          album: item.album,
          cover_url: item.cover_url,
          duration: item.duration,
          source_data: item.source_data,
        }
      })
      const body = { songs: songs, with_lyric: true }
      if (playlistName) body.playlist_name = playlistName
      const result = await api('api/songs/import', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const data = result.data || {}
      const parts = ['已导入 ' + (data.added || 0) + '/' + (data.requested || songs.length) + ' 首']
      if (data.skipped) parts.push('跳过 ' + data.skipped + ' 首')
      if (data.playlist_id) parts.push('歌单：' + (data.playlist_name || '#' + data.playlist_id))
      toast(parts.join('，'), result.warning ? 'warn' : '')
      if (result.warning) {
        setTimeout(function () {
          toast(result.warning, 'warn')
        }, 1800)
      }
    } catch (err) {
      toast('导入失败：' + (err.message || err), 'error')
    } finally {
      if (button) {
        button.disabled = false
        button.innerHTML = original
      }
    }
  }

  async function importSelected() {
    const selected = []
    state.search.results.forEach(function (item, index) {
      if (state.search.selected[index]) selected.push(item)
    })
    if (!selected.length) {
      toast('请先选择要导入的歌曲')
      return
    }
    const playlistName = $('#playlist-name').value.trim()
    await importSongItems(selected, playlistName, $('#import-selected'))
    state.search.selected = {}
    state.search.selectedCount = 0
    renderSearchResults()
  }

  async function importSongsJson() {
    const textarea = $('#songs-json')
    const text = textarea.value.trim()
    if (!text) {
      toast('请先粘贴歌曲 JSON')
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      toast('JSON 解析失败：' + err.message, 'error')
      return
    }
    let items = parsed
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.songs)) items = parsed.songs
    if (!Array.isArray(items) || !items.length) {
      toast('JSON 必须是歌曲数组，或包含 songs 数组', 'error')
      return
    }
    const button = $('#import-json-btn')
    const original = button.innerHTML
    button.disabled = true
    button.textContent = '导入中…'
    try {
      const body = {
        songs: items,
        with_lyric: true,
      }
      const playlistName = $('#import-playlist-name').value.trim()
      if (playlistName) body.playlist_name = playlistName
      const result = await api('api/songs/import', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const data = result.data || {}
      let message = '已导入 ' + (data.added || 0) + '/' + (data.requested || items.length) + ' 首'
      if (data.skipped) message += '，跳过 ' + data.skipped + ' 首'
      if (result.warning) message += '；' + result.warning
      toast(message, result.warning || data.skipped ? 'warn' : '')
    } catch (err) {
      toast('导入失败：' + (err.message || err), 'error')
    } finally {
      button.disabled = false
      button.innerHTML = original
    }
  }

  /* ---------------- 音源导入 ---------------- */

  function renderImportFiles() {
    const list = $('#import-file-list')
    list.innerHTML = ''
    state.importFiles.forEach(function (file, index) {
      const item = el('li', 'file-item')
      item.appendChild(el('span', 'name', file.name))
      item.appendChild(el('span', 'size', formatSize(file.size)))
      const remove = el('button', 'icon-btn')
      remove.type = 'button'
      remove.title = '移除'
      remove.innerHTML = icon('close')
      remove.addEventListener('click', function () {
        state.importFiles.splice(index, 1)
        renderImportFiles()
      })
      item.appendChild(remove)
      list.appendChild(item)
    })
    $('#import-files-btn').disabled = state.importFiles.length === 0
  }

  function addImportFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || [])
    files.forEach(function (file) {
      const name = String(file.name || '')
      if (!/\.(js|zip)$/i.test(name)) {
        toast('已忽略不支持的文件：' + name, 'warn')
        return
      }
      if (file.size > 8 * 1024 * 1024) {
        toast('文件超过 8MB，已忽略：' + name, 'warn')
        return
      }
      const exists = state.importFiles.some(function (item) {
        return item.name === name && item.size === file.size
      })
      if (!exists) state.importFiles.push(file)
    })
    renderImportFiles()
  }

  async function uploadSourceFiles() {
    if (!state.importFiles.length) return
    const button = $('#import-files-btn')
    const original = button.innerHTML
    button.disabled = true
    button.textContent = '导入中…'
    try {
      const form = new FormData()
      state.importFiles.forEach(function (file) {
        form.append('file', file, file.name)
      })
      form.append('enable', $('#import-enable').checked ? 'true' : 'false')
      const result = await api('api/sources/import', { method: 'POST', body: form })
      const data = result.data || {}
      const count = Array.isArray(data.imported) ? data.imported.length : 0
      let message = '已导入 ' + count + ' 个音源'
      if (data.batch || data.loading) message += '，正在后台逐个加载…'
      toast(message + (result.warning ? '；' + result.warning : ''), result.warning ? 'warn' : '')
      state.importFiles = []
      renderImportFiles()
      startSourcePolling()
      setTimeout(function () {
        activateTab('sources')
      }, 900)
    } catch (err) {
      toast('导入失败：' + (err.message || err), 'error')
    } finally {
      button.disabled = state.importFiles.length === 0
      button.innerHTML = original
    }
  }

  async function importSourceUrl() {
    const input = $('#source-url-input')
    const url = input.value.trim()
    if (!url) {
      toast('请填写音源 URL')
      return
    }
    const button = $('#import-url-btn')
    const original = button.textContent
    button.disabled = true
    button.textContent = '导入中…'
    try {
      const result = await api('api/sources/import-url', {
        method: 'POST',
        body: JSON.stringify({ url: url, enable: $('#import-enable').checked }),
      })
      const data = result.data || {}
      const count = Array.isArray(data.imported) ? data.imported.length : 0
      let message = '已导入 ' + count + ' 个音源'
      if (data.batch || data.loading) message += '，正在后台加载…'
      toast(message + (result.warning ? '；' + result.warning : ''), result.warning ? 'warn' : '')
      input.value = ''
      startSourcePolling()
      setTimeout(function () {
        activateTab('sources')
      }, 900)
    } catch (err) {
      toast('导入失败：' + (err.message || err), 'error')
    } finally {
      button.disabled = false
      button.textContent = original
    }
  }

  /* ---------------- 音源管理 ---------------- */

  function statusOf(source) {
    if (!source.enabled && source.status !== 'ready' && source.status !== 'loading') {
      return { key: 'disabled', label: '已停用' }
    }
    if (source.status === 'ready') return { key: 'ok', label: '就绪' }
    if (source.status === 'loading') return { key: 'warn', label: '加载中' }
    if (source.status === 'error') return { key: 'bad', label: '加载失败' }
    return { key: '', label: '待加载' }
  }

  function renderSources() {
    const list = $('#source-list')
    const sources = state.sources.items
    list.innerHTML = ''

    const enabled = sources.filter(function (item) {
      return item.enabled
    }).length
    const ready = sources.filter(function (item) {
      return item.status === 'ready'
    }).length
    $('#sources-summary').textContent =
      sources.length === 0
        ? '尚未导入音源。播放链接解析需要先导入洛雪音源脚本。'
        : '共 ' + sources.length + ' 个音源 · 已启用 ' + enabled + ' 个 · 就绪 ' + ready + ' 个'

    const banner = $('#batch-banner')
    const pending = state.sources.batchPending.length
    if (state.sources.batchLoading || pending) {
      banner.classList.remove('hidden')
      const current = state.sources.batchCurrent
      const currentSource = current
        ? sources.filter(function (item) {
            return item.id === current
          })[0]
        : null
      banner.textContent =
        '后台加载中' +
        (currentSource ? '：' + currentSource.name : '') +
        (pending ? '，队列还有 ' + pending + ' 个音源' : '') +
        '…'
    } else {
      banner.classList.add('hidden')
      banner.textContent = ''
    }

    if (!sources.length) {
      const empty = el('li', 'empty')
      empty.innerHTML = icon('extension') + '<p>暂无音源，请到「导入」标签页添加</p>'
      list.appendChild(empty)
      return
    }

    sources.forEach(function (source) {
      list.appendChild(sourceItem(source))
    })
  }

  function sourceItem(source) {
    const li = el('li', 'source-item')
    if (state.sources.batchCurrent === source.id) li.classList.add('batch-current')

    const head = el('div', 'source-head')
    head.appendChild(el('h3', 'source-name', source.name || source.id))
    if (source.version) head.appendChild(el('span', 'chip', 'v' + source.version))
    const status = statusOf(source)
    head.appendChild(el('span', 'chip ' + status.key, status.label))
    if (state.sources.batchCurrent === source.id) head.appendChild(el('span', 'chip warn', '当前加载'))
    else if (state.sources.batchPending.indexOf(source.id) >= 0) head.appendChild(el('span', 'chip', '排队中'))

    const actions = el('div', 'source-actions')
    const switchLabel = el('label', 'switch')
    const toggle = document.createElement('input')
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

    const remove = el('button', 'icon-btn')
    remove.type = 'button'
    remove.title = '删除音源'
    remove.innerHTML = icon('delete')
    remove.addEventListener('click', function () {
      deleteSource(source)
    })
    actions.appendChild(remove)
    head.appendChild(actions)
    li.appendChild(head)

    if (source.description) li.appendChild(el('p', 'source-desc', source.description))

    const meta = el('div', 'source-meta')
    if (source.author) meta.appendChild(el('span', '', '作者：' + source.author))
    if (source.homepage) meta.appendChild(el('span', '', '主页：' + source.homepage))
    const stats = source.stats || {}
    meta.appendChild(el('span', '', '解析成功 ' + (stats.successCalls || 0) + '/' + (stats.totalCalls || 0)))
    if (source.size) meta.appendChild(el('span', '', formatSize(source.size)))
    li.appendChild(meta)

    const platforms = Array.isArray(source.platforms) ? source.platforms : []
    if (platforms.length) {
      const row = el('div', 'source-platforms')
      platforms.forEach(function (platform) {
        const qualitys = Array.isArray(platform.qualitys) && platform.qualitys.length ? ' · ' + platform.qualitys.join('/') : ''
        row.appendChild(el('span', 'chip', platformName(platform.platform) + qualitys))
      })
      li.appendChild(row)
    }

    if (source.status === 'error' && source.error) {
      li.appendChild(el('p', 'source-error', source.error))
    }
    return li
  }

  async function refreshSources(silent) {
    if (state.sources.requesting) return
    state.sources.requesting = true
    try {
      const result = await api('api/sources')
      const data = result.data || {}
      state.sources.items = Array.isArray(data.sources) ? data.sources : []
      state.sources.batchLoading = !!data.loading
      state.sources.batchCurrent = data.batch_current_id || null
      state.sources.batchPending = Array.isArray(data.batch_pending_ids) ? data.batch_pending_ids : []
      renderSources()
      if (data.loading) scheduleSourcePoll()
    } catch (err) {
      if (!silent) toast('读取音源列表失败：' + err.message, 'error')
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
    const enabled = toggle.checked
    toggle.disabled = true
    try {
      await api('api/sources/toggle', {
        method: 'PUT',
        body: JSON.stringify({ id: source.id, enabled: enabled }),
      })
      toast((enabled ? '已启用「' : '已停用「') + (source.name || source.id) + '」')
      await refreshSources(true)
      if (enabled) startSourcePolling()
    } catch (err) {
      toggle.checked = !enabled
      toast('操作失败：' + err.message, 'error')
    } finally {
      toggle.disabled = false
    }
  }

  async function deleteSource(source) {
    const name = source.name || source.id
    if (!window.confirm('确定删除音源「' + name + '」吗？脚本会同时从插件存储中移除。')) return
    try {
      await api('api/sources?id=' + encodeURIComponent(source.id), { method: 'DELETE' })
      toast('已删除「' + name + '」')
      await refreshSources(true)
    } catch (err) {
      toast('删除失败：' + err.message, 'error')
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    $('#search-btn').addEventListener('click', function () {
      doSearch(true)
    })
    $('#search-input').addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        doSearch(true)
      }
    })
    $('#load-more').addEventListener('click', function () {
      doSearch(false)
    })
    $('#select-all').addEventListener('change', function () {
      const checked = $('#select-all').checked
      state.search.selected = {}
      if (checked) {
        state.search.results.forEach(function (item, index) {
          state.search.selected[index] = true
        })
      }
      state.search.selectedCount = Object.keys(state.search.selected).length
      renderSearchResults()
    })
    $('#import-selected').addEventListener('click', importSelected)

    // 文件选择与拖放
    const dropZone = $('#drop-zone')
    const fileInput = $('#source-file-input')
    dropZone.addEventListener('click', function () {
      fileInput.click()
    })
    dropZone.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        fileInput.click()
      }
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

    $('#import-files-btn').addEventListener('click', uploadSourceFiles)
    $('#import-url-btn').addEventListener('click', importSourceUrl)
    $('#source-url-input').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        importSourceUrl()
      }
    })

    $('#import-json-btn').addEventListener('click', importSongsJson)
    $('#refresh-sources').addEventListener('click', function () {
      refreshSources(false)
    })
    $('#refresh-meta').addEventListener('click', function () {
      loadMeta()
      if (!$('#tab-sources').hidden) refreshSources(false)
      toast('已刷新')
    })

    // 链接对话框
    const dialog = $('#url-dialog')
    $('#url-close').addEventListener('click', function () {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
    })
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) {
        if (typeof dialog.close === 'function') dialog.close()
        else dialog.removeAttribute('open')
      }
    })
    $('#url-copy').addEventListener('click', function () {
      copyText($('#url-text').value)
        .then(function () {
          toast('链接已复制')
        })
        .catch(function (err) {
          toast(err.message || '复制失败', 'error')
        })
    })
    $('#url-open').addEventListener('click', function () {
      const url = $('#url-text').value
      if (!url) return
      window.open(url, '_blank', 'noopener')
    })
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    initTabs()
    bindEvents()
    renderImportFiles()
    renderSearchResults()
    loadMeta()
    $('#search-input').focus()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
