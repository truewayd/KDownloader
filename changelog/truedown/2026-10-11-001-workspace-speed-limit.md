# 下载概览增加限速入口

- 下载中且启用全局限速时，左下角独立显示当前限速值，保留原有实时下载速度和任务统计。
- 点击限速信息可打开下载与网络设置，调整后主窗口自动同步；空闲、取消限速或读取失败时隐藏该入口。
- 收起侧栏时保留可点击图标及完整提示，支持键盘操作、深浅色和窄窗口。

## Verification

- Chromium coverage checks active/idle limits, live speed, read failures, keyboard activation and narrow layouts in both color schemes.
