# ADR-001: Desktop Adapter 技术选择 — AT-SPI（方案 B）

- 状态：**Accepted**
- 日期：2026-08-19
- 验证机器：Ubuntu Kylin 22.04.1 LTS（x86_64，X11 session，DISPLAY=:1）
- ChatGPT Desktop：`chatgpt 26.803.81509 amd64`（Chromium 151.0.7922.76，Owl/Electron 定制构建，buildFlavor=prod）
- 探测产物：`artifacts/probe/20260819-220515/`（environment.txt、cdp-*.txt、atspi-*.txt、脚本；仅保留在作者本地，未随仓库发布；关键发现已总结于本文）

## 背景

需要在官方 ChatGPT Desktop（Linux）上选择一条可靠的 UI 自动化通道，候选优先级：
A) CDP / Playwright attach；B) AT-SPI accessibility；C) chatgpt.com Web fallback。

## 探测结论

### CDP（方案 A）：FAIL

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| `chatgpt --remote-debugging-port=9222` | flag 被接受 | 日志 `DevTools listening on ws://127.0.0.1:9222/devtools/browser/...`（cdp-launch.log） |
| 端口绑定 | 仅 127.0.0.1 | `ss -ltnp`（cdp-probe-1.txt） |
| `/json/version`、`/json/list` | 可用，枚举到 `app://-/index.html` page target | cdp-probe-4.txt |
| browser 级 CDP 会话 | 正常（`Browser.getVersion`、`Target.getTargets`、`Target.attachToTarget` 均有响应） | ws-cdp-test.mjs、browser-session-test.mjs |
| **renderer 级命令** | **全部无响应**：`Runtime.enable`、`Runtime.evaluate`、`Page.captureScreenshot` 发出后永不回复 | browser-session-test.mjs、retry-eval.mjs、screenshot.mjs（TIMEOUT） |
| Playwright `connectOverCDP` | 超时，卡死在 page 初始化 | cdp-attach-result.json |
| 根因 | App 源码中 `allowDevtools(e){return isInternal(e)}`，prod 构建（buildFlavor=prod）禁用页面级 DevTools agent；`Page.getNavigationHistory` 等 browser 侧命令可用，但涉及 renderer JS 的命令被屏蔽 | app-strings.txt、cdp-launch.log 中 `allowDevtools=false allowInspectElement=false` |

结论：CDP 不满足 Go 条件（无法定位 Chat surface、无法输入、无法读取 DOM）。按设计文档 §4.2 不再猜测内部端点，转 AT-SPI。

### AT-SPI（方案 B）：PASS（有条件）

- ChatGPT Desktop 在 AT-SPI 总线上注册为 application `Codex`，其下 frame `ChatGPT` 即普通 Chat surface（另有 frame `Codex`）。
- **条件**：renderer 的 accessibility 树默认不暴露（frame 下 childCount=1 但子节点取不到，Chromium 标准行为）；必须以 `--force-renderer-accessibility` 启动 App。经用户确认后重启验证通过。
- 启用后树完整且语义良好（中文 UI locale），关键 locator 全部命中：
  - composer：`entry name='给 ChatGPT 发消息'`，states 含 EDITABLE，有 Text 接口；
  - New Chat：`push button name='新聊天'`（侧边栏另有 `新对话`）；
  - surface 判定：`push button name='切换模式，当前模式：ChatGPT'` + `toggle button name='聊天'/'工作'`（Composer mode，带 checked state）；
  - sidebar 会话列表：`list` 下 `push button name=<会话标题>`，带 `置顶聊天/归档聊天` 子按钮；
  - composer 工具条：`添加文件等内容`、`选择 ChatGPT 模型`、`听写`；
  - Send 按钮在 composer 为空时不渲染（ChatGPT 标准行为），有文本后出现，Phase 1 按"entry 有文本 → 寻找发送按钮或回车提交"处理；Stop 按钮同理在生成中出现。
- 操作通道：Action 接口（press/click）+ Text 接口 + 键盘事件可用。

### Web fallback（方案 C）

保留为最后手段，本次不实现（设计文档 §9）。

## 决策

采用 **方案 B：TypeScript MCP Server + Python pyatspi sidecar（JSONL over stdio）**。

附加工程要求（进入 ADR 约束）：

1. **启动参数依赖**：App 必须带 `--force-renderer-accessibility`。MCP server 的 health/probe 必须检测该条件；不满足时返回可诊断错误（`ADAPTER_BROKEN` + hint），并提供受控重启脚本（重启需用户确认，不得静默 kill）。
2. **系统 Python**：sidecar 必须使用 `/usr/bin/python3`（带 gi/Atspi 与 pyatspi 的系统解释器），不能用 conda python。
3. **locale 兼容**：本机 UI 为中文，所有 accessible name locator 必须同时兼容中英文文案（name 列表匹配），禁止只用单一语言硬编码。
4. **frame 判别**：普通 Chat surface = frame name `ChatGPT`；若未来出现歧义（多个同名 frame），按设计文档返回 `SURFACE_AMBIGUOUS`。

## 被否决的替代方案

- CDP（见上，renderer 级命令在 prod 构建被禁用）。
- xdotool 坐标点击 / OCR：违反设计文档 §8.4，仅在 AT-SPI 能力缺口处作为最后手段（当前无缺口）。
