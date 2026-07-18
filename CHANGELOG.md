# KDownloader 改动日志

本文整理截至 2026-07-14 的工作区改动及近期提交。当前 `manifest.json` 版本仍为 `1.0.0`，因此以下内容按日期和提交状态划分，不将尚未提交的功能视为已发布版本。

## 未发布：2026-07-14 工作区改动

### Pawchive 下载改用 JSON API

- Pawchive 集成现在只支持 `pawchive.pw` 和 `file.pawchive.pw`，移除了旧的 `pawchive.st` 权限、常量和运行时回退。
- 创作者页面按 50 条一页请求 `/api/v1/{service}/user/{creator_id}?o={offset}`；单帖下载请求 `/api/v1/{service}/user/{creator_id}/post/{post_id}`。
- 下载任务只从 API 返回的 `file` 和 `attachments` 构建，文件地址统一为 `https://file.pawchive.pw/data{path}`，并使用 API 提供的文件名。
- 只有 `has_full === true` 的帖子可以进入下载流程。不完整帖子会在后端分发和历史记录写入前被跳过。
- Pawchive Page Fetch 的翻页和数据获取移到后台处理，页面脚本只负责发起请求和显示进度。

### Cloudflare 验证与同源请求桥

- 新增在 `document_start` 注入的 `content/paw_api_bridge.js`。它只接受扩展发起的、指向同源 `/api/v1/` 的 `GET` 请求，并拒绝任意来源、路径、方法和浏览器身份请求头。
- 后台请求优先使用已打开且未被丢弃的 `pawchive.pw` 标签页，让 Cloudflare 看到真实的同源页面上下文和浏览器管理的 Cookie；没有可用桥接时才回退到后台请求。
- 可识别 `cf-mitigated`、Cloudflare HTML/WAF 页面和被阻止的直连请求。命中后会显示带“打开 Pawchive”操作的常驻通知，并通过冷却时间避免重复打扰。
- 定时 Watch 在没有 Pawchive 标签页时先静默探测第一个创作者。探测成功会复用结果；失败则打开一个非活动、固定的 Pawchive 标签页并等待桥接就绪。手动“立即检查”不会自动打开标签页。
- 不读取、复制或记录 `cf_clearance`，也不会把它放入扩展消息或自定义请求头。

### Pawchive Watch

- 原有占位性质的 Favorites watcher 已替换为仅面向 `pawchive.pw` 的 Pawchive Watch。
- 创作者页面新增幂等的“关注/取消关注”按钮；帖子详情页不显示该按钮。第一次关注会读取 profile 的 `updated` 作为基线，避免把已有内容误报为更新。
- 默认每 30 分钟检查一次，支持“分批检查”和“一次检查”两种模式。分批模式每批最多并发检查 5 位创作者，并在批次之间短暂停顿。
- 单个或多个更新会聚合为一条通知；多项更新使用 `updated` 最新的创作者头像。头像缓存失败时回退到扩展图标，不影响更新判断。
- 添加关注时缓存头像并发送一次示例通知；重复添加不会重复请求或通知。取消关注会同时删除对应头像缓存。
- 设置页可查看关注数量、立即检查，并导入或导出 Watch 列表。导入要求 `schemaVersion: 1`、`site: "pawchive.pw"`，拒绝重复身份和其他站点数据。
- 恢复默认设置只重置检查间隔和模式，不清空 Watch 列表。

### 后端完全失败时改为用户确认

- 启用的第三方后端一个文件都未接收时，不再静默切换到 `chrome.downloads`。
- 待处理任务暂存到 `chrome.storage.session`，并显示带“继续下载”和“取消下载”两个按钮的常驻通知。
- 只有用户确认继续后才使用 Chrome 内置下载，并在确认分发成功后写入历史记录；取消或关闭通知不会写入历史。
- 同一批次的完全失败会合并为一次确认。后端已经接收部分文件时不会提示整批重试，避免重复下载已接收的文件。
- 后端本身未启用时仍保留原有的 Chrome 直接下载路径。

### 稳定性与界面

- 内容脚本能识别扩展重载导致的 `Extension context invalidated`。该错误被视为终止状态，路由观察器会停止定时器和 DOM 监听，避免持续重试、重复日志和页面残留操作。
- 路由渲染加入代次校验，异步结果返回时若页面已经切换，不再向新页面写入旧结果。
- 设置页用 Pawchive Watch 配置替代 Favorites，增加检查模式、关注数量、导入、导出和立即检查控件。
- 英文与简体中文目录同步增加 Watch、Cloudflare 验证、后端失败确认和取消提示等文案，并更新扩展描述。

### 配置、存储与清单变化

| 范围 | 变化 |
| --- | --- |
| Manifest | 移除 `pawchive.st` host permissions；保留 `https://pawchive.pw/*` 和 `https://file.pawchive.pw/*`；增加 Pawchive API 桥的 `document_start` 注入；没有新增权限类型 |
| API 常量 | `PAW.ORIGIN` 固定为 `https://pawchive.pw`，新增 `API_PREFIX`、`FILE_ORIGIN` 和 50 条分页大小 |
| `chrome.storage.sync` | 新增 `watchConfig`，包含 `intervalMinutes` 和 `checkMode` |
| `chrome.storage.local` | 新增 `pawchiveWatches` 和独立的 `pawchiveWatchIcons` 头像缓存 |
| `chrome.storage.session` | 新增 `pendingNativeFallbacks`，用于保存待确认的 Chrome 备用下载任务 |
| IndexedDB | 本轮工作区改动没有升级历史数据库版本或改变历史记录 schema |

## 2026-07-11：本地化与历史数据库重构

对应近期提交 `834ea41`（数据库迁移）和 `3f0dd01`（问题修复，添加中文）。

### 简体中文本地化

- Chrome MV3 默认语言设为英文，并新增 `_locales/en`、`_locales/zh_CN` 与共享的 `shared/i18n.js`。
- 扩展名称和描述、弹窗、设置页、注入页面按钮、状态、错误提示及导入导出流程均改用 i18n key。
- 静态 DOM 在加载时一次性本地化，运行时文案通过带缓存的查询获取，减少重复调用。
- 中英文目录保持相同且非空的 key 集合，并通过测试扫描所有 `data-i18n` 和代码引用。

### 下载历史迁移到 IndexedDB

- 下载历史从 `chrome.storage.local` 的大型对象迁移到 `kdownloaderHistory` IndexedDB，数据库版本升级为 3。
- 每条记录使用 `[source, service, userId, postId]` 复合主键，保存 `status`、文件总数、成功数、失败数和更新时间。
- Kemono、Coomer 与 Pawchive 继续使用 `source=default` 的共享命名空间；只有 CoomerFans 使用 `source=coomerfans`。
- 移除未使用的 creator、status 和 sessionId 二级索引，生成数据改用复合主键范围读取。
- 批量检查与写入在同一事务中完成；历史写入、清空和导入通过事务边界串行化，避免并发覆盖。
- 大型导入使用不超过 4 MiB 的 `begin/chunk/commit/abort` 消息。提交时仅原子切换活动 generation，不逐条复制暂存记录。
- 导入会检查同一批次及跨批次的重复身份；发现重复时返回包含冲突身份的 `Duplicate history identity` 错误，原有活动历史保持不变。
- 导出先固定 generation，再分页读取并增量组装 Blob，避免通过一次 runtime message 发送完整历史。
- `db.stats` 直接读取维护的记录数和字节数元数据，新增或覆盖记录时按差值更新，避免为弹窗统计扫描大表。
- 历史 JSON 使用 `schemaVersion: 2`，完整保留规范化记录字段。新增离线工具 `migrate_history_json.py`，可把旧导出转换为新格式。
- 未发布版本不自动迁移旧的 `downloaded` / `coomerfansDownloaded` 本地存储对象；升级后应使用干净的扩展配置，或先用离线脚本转换旧导出。

## 2026-07-01 至 2026-07-05：下载流程与设置界面整理

- 将大型后台消息路由拆分为 `background/handlers/*`，公共消息、进度和帮助逻辑分别归入独立模块。
- 新增 HTMX 和 History API 感知的内容脚本路由器，统一页面重载、前进后退和局部 DOM 交换后的幂等注入。
- 增加 CoomerFans Creator Fetch：后台发现创作者帖子并解析 `/storage/` 媒体，页面脚本提供单帖和当前页批量下载按钮。
- 弹窗收敛为 Creator Fetch、可选的 Page Fetch/Gist 操作和历史导入导出；后端、批量、Gopeed、Watch、Gist 与缓存配置移到独立设置页。
- 后端未启用时，Creator Fetch 按钮改为设置入口，输入框占位文案直接说明后端要求。
- 新增全局下载进度汇总和弹窗顶部实时进度条。
- Gopeed 改用后台 REST 请求，发送 `Content-Type: application/json` 和 `X-Api-Token`，并移除不受支持的下载路径配置。
- 弹窗和设置页增加随系统切换的浅色/深色主题与一致的操作图标。
- 这一阶段曾短暂拆分本地历史对象，随后已被 2026-07-11 的 IndexedDB 方案完全取代；当前实现以 7 月 11 日后的记录模型为准。

## 兼容性与升级提醒

- `pawchive.st` 已不再受支持，Pawchive 页面、API 和文件请求必须使用 `.pw` 域名。
- 旧 `favoritesConfig` 和 `favoritesCheck` alarm 不迁移到 Pawchive Watch；用户需要在 Pawchive 创作者页重新手动关注。
- Watch 列表和头像缓存分开保存，导出的 Watch JSON 不包含头像二进制数据。
- 下载历史的旧 `chrome.storage.local` 数据不会在扩展运行时自动迁移。需要保留旧历史时，请先导出并使用 `migrate_history_json.py` 转换。
- manifest 内容脚本和 host permissions 已变化，手动加载扩展时需要在 `chrome://extensions` 重新加载后再测试。

## 验证结果

- 56 个 Node 测试通过，覆盖 IndexedDB v3、历史导入导出、下载状态、i18n、扩展上下文失效、Pawchive API/桥接/Watch 和后端备用下载。
- 2 个 Python 测试通过，覆盖旧历史 JSON 到 schemaVersion 2 的离线转换。
- Node 测试应按功能组运行。所有测试文件一次性共用 `--test-isolation=none` 会让各文件的 `chrome` mock 相互覆盖，产生与实现无关的失败。

```powershell
node --test --test-isolation=none tests/backendFallback.test.mjs
node --test --test-isolation=none tests/nativeFallback.test.mjs
node --test --test-isolation=none tests/pawchive.test.mjs tests/pawchiveBridge.test.mjs tests/watch.test.mjs
node --test --test-isolation=none tests/db.test.mjs tests/downloadHistory.test.mjs tests/i18n.test.mjs tests/contentContext.test.mjs
python -m unittest tests/migrate_history_json_test.py
```

建议发布前再手动验证以下流程：切换 Chrome 为英文和简体中文；Pawchive 单帖及创作者 Page Fetch；`has_full=false` 跳过；Cloudflare 验证通知；Watch 添加、更新聚合、导入导出和无标签页定时检查；后端完全失败后的继续、取消和关闭通知；大型历史导入导出及统计刷新。
