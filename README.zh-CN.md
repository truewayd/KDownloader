# KDownloader Monorepo

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<table>
  <tr>
    <td align="center" width="50%">
      <img src="icons/kdownloader-logo.svg" width="112" alt="KDownloader Logo"><br>
      <strong>KDownloader</strong><br>
      Chrome MV3 创作者内容工具
    </td>
    <td align="center" width="50%">
      <img src="truedown/web/truedown-logo.svg" width="112" alt="TrueDown Logo"><br>
      <strong>TrueDown</strong><br>
      跨平台原生下载管理器
    </td>
  </tr>
</table>

本仓库包含两个独立开发、独立发布的项目。KDownloader 位于仓库根目录，TrueDown 位于 `truedown/`。

## KDownloader

KDownloader 是一个零运行时依赖的 Chrome Manifest V3 扩展，用于发现、收集和下载创作者内容。

### 主要功能

- 在 Kemono、Coomer、Pawchive 和 CoomerFans 页面提供统一的帖子、创作者、当前页面和收藏页操作。
- 提供增量下载、全量抓取、外链导出和 Pawchive 私信导出等 Creator Fetch 模式。
- 使用 IndexedDB 记录下载历史，支持分页导出和分块、重复安全的导入流程。
- 支持关注 Pawchive 创作者，并可手动或定时检查更新。
- 可向仅限本机回环地址的 AB 兼容后端或 Gopeed 分发任务；全部失败后才会提供明确确认的 Chrome 下载回退。
- 支持同步到 TrueDown 的 Dropbox 展开过滤器、外链过滤、创作者搜索缓存和可选的 GitHub Gist 同步。
- 后端密钥与 Gist 密钥仅保存在扩展本地存储中。

### 构建与加载

环境要求：

- 支持 Manifest V3 的 Google Chrome 或其他 Chromium 浏览器
- 用于测试的 Node.js
- 用于干净构建脚本的 PowerShell 7

```powershell
npm test
npm run test:python
npm run build
```

未打包扩展会生成到 `dist/KDownloader`。打开 `chrome://extensions`，启用**开发者模式**，选择**加载已解压的扩展程序**，然后选中该目录。

### 配置说明

- 可从扩展弹窗进入高级设置。
- 下载后端地址只能使用 `localhost` 或 `127.0.0.1`。
- API Key 默认可留空；仅在所选后端要求认证时配置。
- 恢复默认设置不会清除 IndexedDB 历史记录和 Pawchive 关注列表。
- `dist/` 是自动生成的构建产物，请勿手动编辑。

## TrueDown

<p align="center">
  <img src="truedown/web/truedown-logo.svg" width="96" alt="TrueDown Logo">
</p>

TrueDown 使用 Go 下载内核与 Tauri 原生桌面界面，支持 Windows、Linux 和 macOS。桌面、命令行与浏览器集成共用基于 aria2 的任务队列、配置和数据库。

### 主要功能

- 默认监听 `127.0.0.1:15151`。
- 下载、分类设置、应用日志和关于使用独立窗口；重新打开设置会保留未保存的编辑。
- 按操作系统提供登录时启动、托盘与窗口风格，Windows 支持 Mica 和按显示器 DPI 选择托盘图标，macOS 支持系统材质与 Retina 模板图标。
- 内置仪表盘支持新建、筛选、分页、表头正逆序排序、暂停、继续、重试、打开和移除任务，并提供整条队列的暂停与恢复。
- 每次提交 Dropbox 共享目录时可选择直接下载压缩包或有界并行展开，并可独立选择过滤；展开结果会批量导入任务队列。
- 将 Dropbox 与 Google Drive 作为可独立安装、移除的内置解析模块，并可在仪表盘中管理安装状态。
- 无需 Google Developer API Key 即可解析公开的 Google Drive 文件、大文件确认页、递归目录，以及 Docs/Sheets/Slides 导出。
- aria2 同时下载任务数会持久化，默认为 3，修改后立即生效。
- 对队列准入、请求大小、批量操作、文件名、目录、请求头和 aria2 参数设置明确上限。
- 支持可选的 API Key 认证；非回环监听必须同时启用认证和 TLS。
- 在同一监听端口实现 AB Download Manager 的 HTTP 浏览器集成兼容接口。
- 使用 SQLite 持久化任务状态，仪表盘快照不会包含敏感请求头。
- 仅在 aria2 确认任务状态后清理活动任务的临时数据；移除已完成记录不会删除下载文件。

### 构建与运行

环境要求：

- Windows、Linux 或 macOS，以及对应的 [Tauri 构建依赖](https://v2.tauri.app/start/prerequisites/)
- Go 1.26.4 或兼容的新版本工具链
- Node.js 22 或更新版本、Rust 1.98.1
- Windows 使用仓库内的稳定 aria2；Linux/macOS 需安装 aria2

```powershell
Set-Location truedown
go test ./...
go vet ./...
npm ci --prefix desktop
pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1
```

Windows 包会生成到 `truedown/dist/TrueDown`，启动 `TrueDown.exe` 即可打开原生下载器。Linux/macOS 使用 `bash truedown/build-unix.sh <linux|darwin> <amd64|arm64>`，须在对应系统和架构上构建；详见 [桌面开发与打包](truedown/desktop/README.md)。

设置提供总览和分类，每页独立保存。在「设置 → 启动与运行」可开启登录时自动启动，登录后驻留托盘。

原生界面与独立服务使用清晰的启动入口：

```text
TrueDown.exe                            打开桌面，复用同一配置的已有服务
TrueDown.exe --background               驻留托盘，暂不显示主窗口
truedown-core.exe serve                 前台运行独立服务
truedown-core.exe --data-dir "D:\Data"   指定配置根目录
```

桌面包包含独立内核和 HTTP 任务管理 CLI。只需 Go 的 Windows 内核开发包可运行 `pwsh -File truedown/build-core.ps1`，输出到 `truedown/dist/core/`：

```text
truedown-core.exe --data-dir "D:\TrueDownData"
truedown-cli.exe --data-dir "D:\TrueDownData" status
truedown-cli.exe add https://example.com/file.zip
truedown-cli.exe --json list --status downloading
truedown-cli.exe pause 12 13
truedown-cli.exe resume 12
truedown-cli.exe retry 13
truedown-cli.exe paths
truedown-cli.exe exit
```

内核默认前台运行，可通过 `http://127.0.0.1:15151` 打开网页。CLI 与桌面共用服务端默认值、任务库及鉴权，CLI 不启动第二个下载管理器。全局参数放在命令前，命令参数放在 URL 或任务 ID 前；API Key 通过 `TRUEDOWN_API_TOKEN` 或配置目录中的 token 文件读取。独立内核的程序升级由部署者管理。

启用认证且使用非默认数据目录时，各条 CLI 命令均需传入 `--data-dir`，或在当前终端设置 `TRUEDOWN_DATA_DIR`。`--data-dir` 选择本地凭据，连接地址仍由 `--endpoint` 或 `TRUEDOWN_ADDR` 指定。

新 Windows 配置使用 `%LOCALAPPDATA%\TrueDown`，按 `config/data/state/logs/cache` 分类。macOS 持久数据使用 `~/Library/Application Support/TrueDown`，日志和缓存分别放入 `~/Library/Logs/TrueDown`、`~/Library/Caches/TrueDown`。Linux 遵循 XDG 配置、数据、状态和缓存目录。配置根清单统一管理各类路径，界面不提供零散的文件路径设置。

`--data-dir` 优先于 `TRUEDOWN_DATA_DIR`，便携配置与识别到的程序旁旧数据仍使用原根目录。首次启动在独占锁下迁移已知数据并保留旧布局备份，下载文件与任务输出路径不变。设置和 `truedown-cli paths` 显示实际位置；任务默认值统一由服务端持久化。

编号 Windows 原生包使用包含桌面、内核、CLI 和许可证的整包更新，启动失败会整体回滚。旧浏览器版本首次迁移需解压完整新包，旧单文件更新器不能安装此格式。Linux/macOS 更换完整平台包。macOS 无发布签名凭据时使用临时签名，已配置的 CI 凭据可用于 Developer ID 签名和公证；本地尚未完成 macOS 运行验收。完整设计和验证范围见 [TrueDown 核心与原生桌面](docs/truedown-core-and-tauri.md)。

如需远程监听，请通过 `TRUEDOWN_ADDR` 指定明确的网卡地址，设置 `TRUEDOWN_ALLOW_REMOTE=1`，启用 API Key 认证，并提供 `TRUEDOWN_TLS_CERT` 与 `TRUEDOWN_TLS_KEY`。程序会拒绝通配地址监听。

## 仓库结构

```text
background/       KDownloader Service Worker 与 RPC 处理器
content/          站点集成、共享内容 UI 与路由监听
popup/            扩展日常操作弹窗
shared/           扩展页面 UI 基础组件、国际化与图标精灵
tests/            Node 与 Python 测试
tools/            扩展构建和发布说明脚本
truedown/         TrueDown Go 内核、CLI、Tauri 桌面与平台构建脚本
changelog/        按产品路径维护的发布说明
```

## 完整验证

```powershell
npm test
python -m unittest tests/migrate_history_json_test.py
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -Product KDownloader -OutputFile release-notes.md

Set-Location truedown
go test ./...
go vet ./...
```

## 发布

KDownloader 与 TrueDown 使用按路径触发的 GitHub Actions 工作流和独立版本标签。同一个提交同时修改两个产品路径时，可以分别发布两个版本。

## 许可证

请参阅 [LICENSE](LICENSE)。
