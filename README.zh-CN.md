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
      独立的 Windows 下载管理器
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
- 支持文件类型排除、外链过滤、创作者搜索缓存和可选的 GitHub Gist 同步。
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

TrueDown 是一个使用 Go 编写的独立 Windows 下载管理器。它把基于 aria2 的任务队列和响应式 Web 仪表盘封装在同一个本地服务中。

### 主要功能

- 默认监听 `127.0.0.1:15151`。
- 内置仪表盘支持新建、筛选、分页、暂停、继续、重试和移除任务。
- 对队列准入、请求大小、批量操作、文件名、目录、请求头和 aria2 参数设置明确上限。
- 支持可选的 API Key 认证；非回环监听必须同时启用认证和 TLS。
- 在同一监听端口实现 AB Download Manager 的 HTTP 浏览器集成兼容接口。
- 使用 SQLite 持久化任务状态，仪表盘快照不会包含敏感请求头。
- 仅在 aria2 确认任务状态后清理活动任务的临时数据；移除已完成记录不会删除下载文件。

### 构建与运行

环境要求：

- Windows
- Go 1.26.4 或兼容的新版本工具链
- `truedown/aria2/aria2c.exe`

```powershell
Set-Location truedown
go test ./...
go vet ./...
pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1
```

Windows 包会生成到 `truedown/dist/TrueDown`。启动 `TrueDown.exe`，然后打开 `http://127.0.0.1:15151`。

如需远程监听，请通过 `TRUEDOWN_ADDR` 指定明确的网卡地址，设置 `TRUEDOWN_ALLOW_REMOTE=1`，启用 API Key 认证，并提供 `TRUEDOWN_TLS_CERT` 与 `TRUEDOWN_TLS_KEY`。程序会拒绝通配地址监听。

## 仓库结构

```text
background/       KDownloader Service Worker 与 RPC 处理器
content/          站点集成、共享内容 UI 与路由监听
popup/            扩展日常操作弹窗
shared/           扩展页面 UI 基础组件、国际化与图标精灵
tests/            Node 与 Python 测试
tools/            扩展构建和发布说明脚本
truedown/         TrueDown Go 运行时、内置仪表盘与构建脚本
changelog/        按产品路径维护的发布说明
```

## 完整验证

```powershell
npm test
python -m unittest tests/migrate_history_json_test.py
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -OutputFile release-notes.md

Set-Location truedown
go test ./...
go vet ./...
```

## 发布

KDownloader 与 TrueDown 使用按路径触发的 GitHub Actions 工作流和独立版本标签。同一个提交同时修改两个产品路径时，可以分别发布两个版本。

## 许可证

请参阅 [LICENSE](LICENSE)。
