# TrueDown 标题栏悬浮提示

- 保留共享网页悬浮提示，通过受限的原生裁剪区域联动，使提示可覆盖 Windows 标题栏按钮。
- 仅放行当前提示的圆角范围，保留其他区域的系统按钮交互和窗口缩放边缘；关闭提示、切换窗口或导航后恢复裁剪。
- 保留键盘描述、Escape 关闭、DPI 缩放和原生桥接不可用时的安全位置回退。
- 精简开机启动开关下的重复状态说明，保留用途说明和异常反馈。

## Verification

- `npm run ui:check`
- `npm test`
- `cargo test --locked` and `cargo clippy --locked --all-targets -- -D warnings` in `truedown/desktop`
- `npm run test:tooltips` in `truedown/desktop`
- `node truedown/desktop/tests/windows-caption-visual.mjs --visible`
