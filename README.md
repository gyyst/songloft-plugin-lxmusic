# 洛雪音源（Songloft 插件）

把洛雪音乐生态接入自托管的 [Songloft](https://github.com/songloft-org) 音乐服务器：

- **多平台搜索**：内置移植自 lx-music-desktop / lxserver 的 `musicSdk`，直接访问酷我、酷狗、QQ 音乐、网易云音乐、咪咕的公开搜索、歌词、歌单与排行榜接口。
- **自定义音源**：导入洛雪音乐格式的音源脚本（`.js` / 含脚本的 `.zip` / URL），在独立 QuickJS 子 VM 中运行，用脚本解析真实播放链接。
- **与主程序集成**：实现 Songloft 的搜索与播放链接契约，支持把歌曲（含歌词、封面、去重键）批量写入宿主机库，可直接在 Songloft 中搜索、播放、收藏。

> 本插件**不附带任何音源脚本**。音源脚本由用户自行导入，脚本及其数据均为第三方版权内容。

## 功能

| 模块 | 说明 |
| --- | --- |
| 搜索 | 聚合五平台公开接口，按平台交错展示；内置平台元数据（无需音源脚本）。 |
| 播放链接 | 调用已导入的音源脚本，按 `flac24bit → flac → 320k → 128k` 自动降级，多音源并发竞速并按成功率排序。 |
| 音源管理 | 脚本导入（文件 / 批量 ZIP / URL）、启停、删除、加载状态与调用统计；批量导入后台排队逐个加载，避免占满沙箱。 |
| 歌单 | 各平台歌单标签、排序、列表、详情与歌单搜索。 |
| 排行榜 | 各平台榜单列表与榜单歌曲。 |
| 本地音乐 | 浏览宿主机库歌曲与歌单，支持关键词筛选并直接播放。 |
| 插件更新 | 设置页查看当前版本、检查并一键安装新版本；可开启 Songloft 后台自动更新（全站开关）。 |
| 导入曲库 | 批量写入宿主机库（去重键优先 `songmid → musicId → hash → copyrightId`），可自动附带歌词并加入指定歌单。 |
| 语音点歌 | 自动注册为 [mi-song-gpt](https://github.com/wyrt000/mi-song-gpt) 的外部搜索源，小米音箱说「播放 XX」即可经洛雪音源解析并推流。 |

## 与 Songloft 的接口

插件入口 `entryPath = lxmusic`，所有路由位于 `/api/v1/jsplugin/lxmusic/` 下。

### 主程序契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/search` | 入参 `{keyword, source_id, quality, page, page_size}`，返回 `{results: SearchResultItem[]}`。`source_data` 结构为 `{platform, quality, songInfo}`。 |
| `POST` | `/api/music/url` | 用 `source_data` 解析播放链接；返回 `{url, headers}`，`headers` 供主程序代理携带 Referer / UA。主源失败时可在插件内跨平台自搜最匹配项。 |
| `POST` | `/api/songs/import` | 批量导入宿主机库，可附带歌词 URL 与歌单。 |

### 插件内部接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/meta` | 平台列表、音质选项与默认音质。 |
| `GET` | `/api/sources` | 音源列表、运行状态、统计与批量加载进度。 |
| `POST` | `/api/sources/import` | multipart 导入 `.js` / `.zip`（字段 `file`，可多个），或 JSON `{script}`。 |
| `POST` | `/api/sources/import-url` | JSON `{url, enable}` 从直链导入。 |
| `DELETE` | `/api/sources?id=` | 删除音源脚本。 |
| `PUT` | `/api/sources/toggle` | JSON `{id, enabled}` 启停音源。 |
| `GET` | `/api/songlist/{tags,sorts,list,detail,search}` | 歌单浏览。 |
| `GET` | `/api/leaderboard/{boards,list}` | 排行榜浏览。 |
| `POST` | `/api/direct/music/url` | 直接解析播放链接（返回统一 `{code,msg,data}`）。 |
| `GET` | `/api/direct/lyric` | 歌词；默认返回宿主 LyricFetcher 需要的 `{code:0,data:{lyric,tlyric}}`，`format=text` 返回纯 LRC。 |
| `POST` | `/api/search/topone` | 搜索并返回最佳匹配（三合一）；同时是 mi-song-gpt 的外部搜索源契约，返回含 `plugin_entry_path`、`dedup_key`、歌词 URL 的可入库结构。 |

插件自带静态页面 `/api/v1/jsplugin/lxmusic/`：左侧导航包含搜索、歌单、排行榜、本地音乐与设置五个页面，底部为悬浮播放条（支持队列、播放模式、进度拖动、音量与折叠），设置页集中管理音源脚本导入、启停、删除、默认音质与插件更新。

## 插件更新

`plugin.json` 通过 `updateUrl` 指向仓库根目录的最新清单，`download_url` 指向对应 Release 的 `lxmusic.jsplugin.zip`。设置页「插件更新」提供：

- **检查更新**：读取 Songloft 的已安装插件列表与远程清单，显示当前版本与最新版本；
- **立即更新**：调用宿主更新接口下载并安装新版本，随后自动热重载并刷新页面；
- **Songloft 自动更新**：写入宿主全站开关 `plugin_auto_update`。开启后 Songloft 会在启动约 5 分钟后及之后每 6 小时检查一次所有带更新源的插件，自动下载安装并热重载；插件正忙时会推迟重载，等空闲后补做。

检查与安装更新需要 Songloft 管理员权限；旧版宿主若没有对应接口，页面会提示「当前 Songloft 版本不支持该功能」。也可以继续在插件管理页手动上传 ZIP 覆盖更新。

## 与小米智能音箱配合（mi-song-gpt）

[mi-song-gpt](https://github.com/wyrt000/mi-song-gpt) 是运行在 Songloft 上的小爱音箱插件：它监听音箱语音指令，本地曲库未命中时按优先级调用外部搜索源，拿到结果后交给 Songloft 入库，并通过 MIoT / MiNA 把播放 URL 推给音箱。本插件把 `/api/search/topone` 注册为它的外部搜索源，语音点歌链路如下：

```
小米音箱（小爱）
  ↕ MIoT 云 / MiNA
Songloft + mi-song-gpt（智能音箱插件）
  ↕ songloft.comm（注册搜索源）+ loopback HTTP（POST /api/search/topone）
本插件（lxmusic）
  ↕ QuickJS 沙箱内的洛雪音源脚本
酷我 / 酷狗 / QQ 音乐 / 网易云 / 咪咕
```

### 前置条件

1. Songloft 已安装并启用 mi-song-gpt，完成小米账号登录、音箱启用，且 `server_host` 配置为**音箱可访问的局域网/公网地址**（不能是 `127.0.0.1`）。
2. 本插件已导入至少一个可用的洛雪音源脚本，并在「音源管理」中启用。搜索本身不依赖脚本，但播放链接解析依赖它。
3. 如果 mi-song-gpt 的「外部搜索」设置要求先开语音功能，需同时开启「对话监听」与「语音口令」。

### 配置步骤

1. **安装/重载本插件**。插件初始化时会调用
   `songloft.comm.call('mi-song-gpt', 'register-search-provider', {...})`
   把自身注册为搜索源候选。若 mi-song-gpt 尚未安装，注册会静默失败；之后打开本插件页面（或重启本插件）会自动重试，注册接口幂等。
2. **在 mi-song-gpt 中启用搜索源**：打开 mi-song-gpt 插件页 → 语音设置 →「外部搜索」：
   - 开启「启用外部搜索」；
   - 在「已安装搜索源」的快速选择里选「洛雪音源」，它会加入
     `/api/v1/jsplugin/lxmusic/api/search/topone` 并启用；
   - 按需设置搜索优先级（本地优先 / 外部优先 / 并行）与超时（建议 ≥ 6 秒）。
   - 若没有自动出现，也可手动添加上述 URL（相对路径即可）。
3. **对音箱说**「播放晴天」「我想听周杰伦的晴天」。mi-song-gpt 解析出歌名后先查本地曲库；未命中则请求本插件的 `POST /api/search/topone`。本插件返回：
   ```json
   {
     "code": 0,
     "data": {
       "title": "晴天",
       "artist": "周杰伦",
       "plugin_entry_path": "lxmusic",
       "source_data": { "platform": "tx", "quality": "320k", "songInfo": { "...": "..." } },
       "dedup_key": "tx:xxxx",
       "lyric": "/api/v1/jsplugin/lxmusic/api/direct/lyric?...",
       "lyric_source": "url"
     }
   }
   ```
   mi-song-gpt 用 `/api/v1/songs/remote` 把结果写入宿主曲库；音箱点播时宿主再回调本插件 `/api/music/url`，由音源脚本实时解析出真实播放地址。

### 行为说明与排错

- **解析型结果**：本插件不返回音频直链，因此 mi-song-gpt 的「不入库直接播放」对洛雪结果不生效，首次点播会生成一条 remote 曲目。之后每次播放都会重新解析，音源的临时链接过期不会影响回放。
- **音质/格式**：小米音箱对 mp3 兼容性最好。若音源脚本只返回 flac 等格式，请在 mi-song-gpt 播放设置中开启「强制 MP3」/「音量均衡」，由 Songloft 转码后推流。
- **搜到但没声音**：先确认对应平台有已启用的音源脚本。本插件会优先从「音源已就绪」的平台中挑歌；若所有平台都没有音源，会退回普通搜索结果（能搜到但播放必然失败）。
- **注册失败**：常见原因是 mi-song-gpt 未安装/未启用、Songloft 宿主版本不满足 mi-song-gpt 的要求（其清单要求 2.9.5+，插件间 `comm` 也依赖较新的宿主）、或本插件清单缺少 `inter-plugin` 权限。注册失败不影响搜索、音源管理、手动导入等原有功能。
- **排查日志**：mi-song-gpt 侧看 `[OnlineSearcher]` 前缀日志（请求 URL、响应状态与 body）；本插件侧看 `/api/search/topone`、`/api/music/url` 的报错。

## 开发与构建

要求 Node.js 20+。

```bash
npm install
npm run typecheck   # TypeScript 类型检查
npm run build       # 产物：dist/lxmusic.jsplugin.zip
npm run validate    # 校验 plugin.json 中的 entryHash / zipHash
npm run dev         # 监听变更并上传到本地 Songloft（需按 CLI 提示登录）
```

技术约束：

- 运行在宿主 QuickJS 沙箱，仅使用 `fetch`、`setTimeout`、`Buffer`、`crypto`、`zlib` 与 `songloft.*` 桥接。
- 唯一 SDK 依赖是 `@songloft/plugin-sdk`；平台接口全部自行实现，未依赖任何外部音乐 SDK 包。
- 音源脚本运行在 `songloft.jsenv` 创建的独立子 VM 中，通过注入的 `lx` prelude 与宿主通信；不移植 lxserver 的 `getMusicUrl → userApi` 链路。

## 安装

1. `npm run build` 得到 `dist/lxmusic.jsplugin.zip`。
2. 在 Songloft 管理后台的插件页面上传该 zip（或使用 `npm run publish`）。
3. 打开插件页面，在「设置」页添加音源脚本；随后即可在 Songloft 中搜索与播放。

## 发布

`.github/workflows/release.yml` 支持手动触发（workflow_dispatch）：

1. 未填写版本号时自动使用日期版本（`YYYY.M.D`）；
2. `npm ci` + `npm run build`；
3. 创建 GitHub Release 并上传 `dist/lxmusic.jsplugin.zip`；
4. 回写 `plugin.json` 的 `download_url` / `version` 并提交。

## 免责声明

- 本插件仅供**个人学习与研究**使用，**禁止商用**。
- 本插件**不附带任何音源脚本**；内置 `musicSdk` 仅访问各平台公开的搜索、歌词、歌单、排行榜接口，不提供任何受版权保护的音频内容。
- 用户导入的音源脚本及其解析出的数据均为第三方版权内容，版权归原权利人所有。用户应自行确保使用行为合法，并在不再使用时**自行清除产生的版权数据**。
- 因使用本插件产生的任何法律责任由使用者自行承担。

## License

Apache-2.0
