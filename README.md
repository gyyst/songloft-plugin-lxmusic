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
| 导入曲库 | 批量写入宿主机库（去重键优先 `songmid → musicId → hash → copyrightId`），可自动附带歌词并加入指定歌单。 |

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
| `POST` | `/api/search/topone` | 搜索并返回最佳匹配（三合一）。 |

插件自带静态页面 `/api/v1/jsplugin/lxmusic/`，包含搜索、导入、音源管理三个标签页。

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
3. 打开插件页面，在「导入」标签页添加音源脚本；随后即可在 Songloft 中搜索与播放。

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
