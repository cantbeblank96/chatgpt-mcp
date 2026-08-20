# Compatibility Matrix

实测环境（Phase 0 / Phase 1 验证机）：

| 项 | 值 |
| --- | --- |
| OS | Ubuntu Kylin 22.04.1 LTS（x86_64） |
| 会话 | X11（`XDG_SESSION_TYPE=x11`，DISPLAY=:1） |
| ChatGPT Desktop | `chatgpt 26.803.81509 amd64`（Chromium 151.0.7922.76，Owl/Electron 定制构建，buildFlavor=prod） |
| Node.js | v24（≥18 均可） |
| Python sidecar | `/usr/bin/python3` 3.10 + gi（Atspi 2.0 / Gtk 3.0） |
| UI locale | 中文（zh）——locator 同时兼容英文 |

## Adapter 通道

| 通道 | 状态 | 说明 |
| --- | --- | --- |
| CDP / Playwright attach | ❌ 不可用 | browser 级 CDP 可用，renderer 级命令（`Runtime.*`、`Page.captureScreenshot`）在 prod 构建被 `allowDevtools=isInternal` 屏蔽，永不响应。证据：`artifacts/probe/20260819-220515/cdp-*.txt` |
| AT-SPI | ✅ 可用（有条件） | 必须 `chatgpt --force-renderer-accessibility` 启动；否则 frame 子树为空，health/probe 返回 `ADAPTER_BROKEN` |
| Web fallback (chatgpt.com) | 🕒 未实现 | 保留为最后手段 |

## 已验证能力（Phase 1）

| 能力 | 状态 |
| --- | --- |
| 进程/flag/surface/composer 健康检查 | ✅ |
| New Chat（`push button 新聊天`） | ✅ |
| composer 清空（ctrl+a + Delete，带重试验证） | ✅ |
| 剪贴板粘贴输入（Gtk.Clipboard + ctrl+v，读回校验，剪贴板保存/恢复） | ✅ |
| 发送（`push button 发送`）+ commit 验证 | ✅ |
| 生成状态检测（停止按钮 + status bar） | ✅ |
| 新回复提取（`你说：`/`ChatGPT 说：` heading 分段 + 文本稳定窗口） | ✅ |
| 幂等 request_id（operation store 持久化） | ✅ |
| conversation fingerprint 校验（CONVERSATION_STALE） | ✅ |
| 长会话（100 轮压测，消息列表虚拟化场景） | ✅ Phase 2 |
| 服务端限流检测（`RATE_LIMITED`，陈旧横幅免疫） | ✅ Phase 2 |

## Phase 2 压测认知（100 轮 ask，§16 验收通过）

### 消息列表虚拟化

ChatGPT Desktop 的消息列表只渲染最近约 **14–16 条**消息，旧消息会从
accessibility 树中卸载。后果与对策：

- 绝对计数（user/assistant count）在长会话中 **plateau**，不能作为完成判定或
  计数审计依据 → 完成检测改用**结构性条件**：我们提交的 prompt 之后出现
  assistant 消息，且生成结束、文本稳定。
- 全量 fingerprint 会因旧消息卸载而**自然漂移** → 会话校验改为
  `尾部指纹（末 12 条）OR 结构锚点（lastUserPrompt 仍可见）`。
- 审计脚本用 `scripts/audit_conv.py`（虚拟化安全：visible count > expected
  才算重复发送，last_user 文本比对做身份校验）。

### a11y 行内格式占位符（U+FFFC）

paragraph 层的 Text 接口对粗体/代码等行内格式返回 `U+FFFC`，真实文本在
嵌套 static 子节点；且 wrapper static 自身 Text 接口会聚合子文本（递归收集
会双写）。`atspi_worker.py` 采用 **只收叶子 static** 并替换占位符。

### HTTP 429 限流

快速连发会触发账号限流，UI 显示 "Request failed with status 429" 横幅。
注意两点：

- 横幅是**陈旧 UI 残留**：限流恢复后仍可能留在界面上，`new_chat` 可清除。
  因此发送前记录 baseline 横幅，等待期仅对**新出现**的横幅抛 `RATE_LIMITED`。
- 压测建议轮间 pacing ≥ 25s；收到 `RATE_LIMITED` 后退避（实测约 10 分钟恢复），
  再 `new_chat` 清横幅重试。

## 未验证 / 不支持

- Wayland 会话（xdotool/X11 依赖）
- 英文以外其他语言的 UI locale（heading/placeholder 文案需扩充 `PLACEHOLDER_TEXTS` 等常量）
- 多开实例并行（设计上单实例串行）
- Thinking/Pro 模式选择、文件上传（Phase 3 能力测试不通过，见下）
- App 最小化到托盘后的自动恢复（建议保持窗口可见；`--onlyvisible` 窗口搜索找不到时会报 `SURFACE_NOT_FOUND`）

## Phase 3 能力测试结论（2026-08-20）

| 能力 | 结论 | 说明 |
|---|---|---|
| 会话列表 | ✅ 已实现 `chatgpt_list_conversations` | 侧栏 `list`→`list item`→首 `push button`；虚拟化仅返回已渲染行 |
| cancel | ✅ 已实现 `chatgpt_cancel` | 不入全局互斥锁；空闲 no-op |
| 模式选择 | ❌ 不实现 | 按钮 Action 为 `open`，执行后无可见弹窗、无 a11y 节点（截图确认） |
| 文件上传 | ❌ 不实现 | 需驱动原生文件对话框，未通过能力测试 |

### 窗口定位规范

一律按 WM_CLASS（`--classname ChatGPT`）激活窗口，禁止按标题匹配：
Chrome 同名标签页曾被误中，导致激活/按键/坐标点击送入用户浏览器。

### IME 中文模式 preedit 吞噬合成按键（已硬化）

用户 IME（IBus 拼音）处于中文模式时，合成字符键流入 preedit（候选框）而非 composer，
残留 preedit 还会吞掉后续 ctrl+v 等序列，表现为“粘贴失效”。
对策：`m_composer_set` 在清空/粘贴前发 `Escape` 取消活跃 preedit（无 preedit 时 no-op）。
自动化期间建议调用方理解该行为；本机制已在 IME 中文模式下验收通过。

## App 版本升级回归

ChatGPT Desktop 更新后依次执行：

```bash
npm run probe          # 结构健康
npm test               # 离线单测
npm run test:smoke     # 真实链路
```

若 accessible name 变化（如"发送"改名），更新 `atspi_worker.py` 顶部的
locator 常量（`SEND_NAMES` / `NEW_CHAT_NAMES` / `PLACEHOLDER_TEXTS` 等）。
