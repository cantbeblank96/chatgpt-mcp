# Ubuntu ChatGPT Desktop → MCP Server

## 工程实现技术设计方案

> 目标：将 Ubuntu 上官方 ChatGPT Desktop 的 Chat 模式封装为本地 MCP Server， 供 Claude Code、Cursor 与自定义 Agent 作为工具调用。

版本 v1.0  |  2026-08-19  
状态：Engineering Design / PoC-Ready

**适用对象：项目负责人、Linux/桌面自动化工程师、MCP/Agent 平台工程师、测试与安全负责人**

---

# 文档控制

| 字段 | 内容 |
| --- | --- |
| 文档名称 | Ubuntu ChatGPT Desktop → MCP Server 工程实现技术设计方案 |
| 版本 | v1.0 |
| 日期 | 2026-08-19 |
| 目标平台 | Ubuntu 24.04 LTS / 26.04 LTS（官方 Linux ChatGPT Desktop preview 支持范围） |
| 目标 MCP Client | Claude Code、Cursor、自定义 MCP Client；其他客户端按兼容性测试结果接入 |
| 推荐语言 | TypeScript/Node.js（MCP 主进程） + 可选 Python sidecar（AT-SPI 适配器） |
| 设计状态 | 可进入 Phase 0/Phase 1 PoC；生产部署受合规 Gate 约束 |
| 变更原则 | ChatGPT App UI/版本变化必须通过 adapter contract 与自动化回归测试吸收，不向 MCP API 泄漏 UI 细节 |

> **重要合规 Gate**  
> 本设计描述的是技术实现路径，不等同于对生产使用方式的授权。截至 2026-08-19，OpenAI 面向个人的 Terms of Use 明确禁止“自动或程序化提取数据或 Output”。如果项目使用个人 ChatGPT 账户/订阅通过 UI 自动读取回复并转交给另一个 Agent，应在开发进入持续自动化或生产阶段之前确认适用合同、组织政策及 OpenAI 授权。若无法获得明确许可，正式生产应改用官方 API 或官方 codex mcp-server。见 R8、R9。

# 执行摘要

本项目的目标不是调用 OpenAI API，也不是让 ChatGPT 去调用 MCP，而是将 Ubuntu 上正在运行的官方 ChatGPT Desktop 的“Chat”体验抽象成一个本地 MCP Server，使 Claude Code、Cursor 或自定义 Agent 能通过标准 MCP tools 发起问题、继续对话并读取回复。

现有社区项目 claude-chatgpt-mcp 已验证了该模式在 macOS 上的工程可行性：MCP 层使用标准 stdio Server，平台相关部分通过 AppleScript/JXA 与 macOS Accessibility 操作 ChatGPT Desktop。Ubuntu 迁移的正确方式不是重写 MCP，而是保留协议层，替换 Desktop Adapter。该判断可直接从其 index.ts 中 MCP Server 与 AppleScript/JXA 的清晰边界得到验证（R3、R4）。

推荐采用“能力探测 + 多适配器降级”的架构：优先尝试 CDP（Chrome DevTools Protocol）连接官方 Linux App；若目标版本未开放或不稳定，则使用 Linux AT-SPI accessibility；若 Desktop UI 自动化不可维护，再退到专用浏览器 profile 的 ChatGPT Web adapter。CDP 目前必须视为待验证能力：OpenAI 官方文档公开了 Linux App 的 Ozone/Wayland 启动参数，但没有公开承诺 remote-debugging-port。

| 层级 | 实现 | 优先级 | 预期维护性 | 是否官方保证 |
| --- | --- | --- | --- | --- |
| A | CDP / Playwright attach 到 ChatGPT Desktop | 最高：先 PoC | 高（若可用） | 否；需现场验证 |
| B | AT-SPI / pyatspi2 控制 Desktop accessibility tree | 主备用 | 中 | Linux accessibility 标准可用，但 App 暴露质量需验证 |
| C | Playwright + 专用 Chromium profile 自动化 chatgpt.com | 最终 fallback | 中-低 | Playwright 能力官方；ChatGPT DOM 不是稳定 API |

> **推荐立项结论**  
> 批准一个 1 个工程迭代的受控 PoC：先用 0.5–1 天完成 CDP/AT-SPI 能力探测，再依据结果实现 MVP。不要在 Phase 0 之前押注某一种 UI 自动化技术。

# 目录

- 1. 目标、范围与非目标
- 2. 已确认事实、推断与待验证项
- 3. 总体架构与设计原则
- 4. Phase 0：目标机器能力探测
- 5. MCP 对外接口设计
- 6. 核心领域模型与 Adapter Contract
- 7. 方案 A：CDP Desktop Adapter
- 8. 方案 B：AT-SPI Desktop Adapter
- 9. 方案 C：ChatGPT Web Fallback Adapter
- 10. 会话、并发、状态与响应完成检测
- 11. 错误模型、恢复策略与幂等
- 12. 配置、日志、可观测性与安全
- 13. 部署与 Claude Code / Cursor 接入
- 14. 分阶段实施计划
- 15. 测试策略与测试矩阵
- 16. 验收标准
- 17. 风险清单与缓解措施
- 18. 生产合规 Gate 与替代路径
- 19. 推荐仓库结构与代码骨架
- 20. 工程任务拆分（可直接建 Jira）
- 附录 A. PoC 命令清单
- 附录 B. MCP Schema 示例
- 附录 C. 参考资料

# 1. 目标、范围与非目标

## 1.1 项目目标

- 在 Ubuntu 24.04/26.04 上，将官方 ChatGPT Desktop 的 Chat 模式暴露为本地 MCP Server。
- 让 Claude Code、Cursor 或自定义 Agent 可调用结构化工具，例如 chatgpt.ask、chatgpt.new_chat、chatgpt.continue_chat、chatgpt.health。
- 不要求 Agent 理解 ChatGPT UI；所有 UI 差异封装在 Adapter 内部。
- 允许未来在 CDP、AT-SPI、Web 适配器之间切换，而 MCP tool schema 保持稳定。
- 提供足够的状态、错误、日志与回归机制，使工程团队能够在 ChatGPT Desktop 频繁更新时快速修复。

## 1.2 MVP 范围

| 能力 | MVP | 说明 |
| --- | --- | --- |
| 健康检查 | 必须 | 检测 ChatGPT App/adapter 可用、登录态可操作、是否忙 |
| 新建 Chat | 必须 | 打开新的普通 Chat |
| 发送 prompt 并等待最终回复 | 必须 | 核心 atomic tool；默认串行执行 |
| 继续已有会话 | 必须 | 以 MCP server 自己维护的 conversation handle 为主 |
| 列出近期会话 | 可选 P1 | UI 变化风险较大，可延后 |
| 模型/Instant/Thinking/Pro 切换 | P1 | 只有 locator 稳定后开放；不得依赖显示文本作为唯一选择器 |
| 文件附件 | P1 | 需额外处理文件选择器、上传完成状态和权限 |
| Work/Codex/Deep Research | 非 MVP | 不同产品体验与长任务语义，单独设计 |
| 并行多会话 | 非 MVP | 单实例 GUI 天生共享状态；MVP 使用全局互斥锁 |

## 1.3 非目标

- 不实现 OpenAI 私有/未公开网络 API 的逆向调用。
- 不拦截或修改 ChatGPT 网络流量，不绕过登录、限额、订阅或安全措施。
- 不读取、导出或复制浏览器/ChatGPT 的凭据、session token 或 cookie 作为产品接口。
- 不修改 ChatGPT 安装包、不解包后篡改应用资源来注入代码。
- 不承诺 UI 自动化具有与官方 API 同等的兼容性、SLA 或长期稳定性。
- 不在合规 Gate 未通过时将个人 ChatGPT 订阅作为面向团队/服务端的程序化推理后端。

# 2. 已确认事实、推断与待验证项

## 2.1 已确认事实

| ID | 事实 | 证据 |
| --- | --- | --- |
| F1 | OpenAI 已于 2026-08-14 宣布 Linux Desktop public preview。 | OpenAI ChatGPT Release Notes（R1） |
| F2 | 官方支持 Ubuntu 24.04 LTS、26.04 LTS，另支持 Debian 13、Fedora 43/44；x64/ARM64 有安装包。 | OpenAI Linux Desktop 文档（R2） |
| F3 | Linux App 可通过 chatgpt 命令启动；Native Wayland 仍属实验性，可使用 --ozone-platform=wayland；默认可借助 XWayland。 | R2 |
| F4 | claude-chatgpt-mcp 的协议层是标准 MCP stdio；平台层直接依赖 run-applescript 与 @jxa/run。 | 仓库 index.ts（R4） |
| F5 | claude-chatgpt-mcp 对外核心能力为 ask/get_conversations，支持 conversation_id；README 说明可继续已有 ChatGPT conversation。 | R3、R4 |
| F6 | Linux AT-SPI 有成熟 Python bindings（pyatspi2）；Ubuntu 24.04 提供 python3-pyatspi 与 Accerciser。 | GNOME/Ubuntu 文档（R6、R7） |
| F7 | Playwright 可通过 connectOverCDP 连接现有 Chromium-based browser；CDP 只适用于 Chromium 系。 | Playwright 官方文档（R5） |
| F8 | 官方 codex mcp-server 已存在，可作为合规/稳定替代路径。 | OpenAI Codex MCP Server 文档（R9） |

## 2.2 工程推断（不得写成既定事实）

- Linux ChatGPT Desktop 很可能包含 Chromium/Electron/Ozone 技术栈迹象，但本设计不依赖该推断；是否可通过 CDP 自动化必须在用户实际版本上验证。
- 即便进程接受 Chromium 常见 flag，也不代表 OpenAI 支持或承诺这些 flag；App 更新可能随时改变。
- AT-SPI 是否能暴露 composer、Send/Stop、assistant message、sidebar conversation 等关键元素，取决于 App 的 accessibility 实现质量。
- 普通 Chat 的模型选择器、Thinking 状态、响应 DOM/accessible role 都可能因账号、A/B test、语言、窗口大小而变化。

## 2.3 Phase 0 必须验证的项目

| 验证项 | 通过条件 | 失败后的决策 |
| --- | --- | --- |
| CDP 监听 | 用 localhost 端口可访问 /json/version 或等价 DevTools discovery，且能枚举 ChatGPT target | 进入 AT-SPI |
| CDP 页面定位 | 能找到当前 Chat surface，读取可见 UI，不需要内部 API/网络拦截 | 进入 AT-SPI |
| AT-SPI 树完整度 | 能识别输入区、发送动作、assistant 文本，且 20 次测试稳定 | 进入 Web fallback |
| 响应结束信号 | 能可靠识别流式生成完成，不依赖固定 sleep | 否则不可进入 MVP |
| Conversation handle | 新建/继续会话后能通过可重建标识重新定位 | MVP 仅保持单会话，历史能力延后 |
| 合规 | 项目负责人确认适用协议允许该自动化，或已获授权 | 仅保留 PoC；生产使用官方路径 |

# 3. 总体架构与设计原则

## 3.1 推荐架构

*图 1  推荐逻辑架构*

```typescript
┌─────────────────────────────────────────────────────────────┐
│ MCP Clients                                                 │
│ Claude Code / Cursor / Custom Agent                         │
└───────────────────────┬─────────────────────────────────────┘
                        │ MCP stdio (MVP)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ chatgpt-desktop-mcp                                         │
│                                                             │
│  MCP Tool Layer                                             │
│    ├─ health                                                │
│    ├─ new_chat                                              │
│    ├─ ask                                                   │
│    ├─ continue_chat                                         │
│    └─ ...                                                   │
│           │                                                 │
│  Orchestrator / State / Lock / Timeout / Error Mapper       │
│           │                                                 │
│  ChatGPTAdapter interface                                   │
└───────────┬────────────────┬────────────────────────────────┘
            │                │
     ┌──────▼───────┐ ┌──────▼────────┐ ┌────────────────────┐
     │ CDP Adapter  │ │ AT-SPI Adapter│ │ Web Adapter        │
     │ Priority A   │ │ Priority B    │ │ Fallback C         │
     └──────┬───────┘ └──────┬────────┘ └─────────┬──────────┘
            │                │                    │
            └──────────────┬─┴────────────────────┘
                           ▼
                  ChatGPT product surface
```

## 3.2 设计原则

Adapter 隔离：MCP tools 不出现 selector、window title、AT-SPI role、CDP target id 等 UI 细节。

能力探测：启动时或首次调用时返回 capabilities；对 unsupported 能力显式失败，不做猜测点击。

单写者模型：一个 ChatGPT Desktop 实例视为单共享设备，MVP 全局串行化。

可观察而非固定等待：等待“状态条件”而不是 sleep N 秒；固定 sleep 只能用作很短的防抖。

Fail closed：当无法确定当前处于 Chat、Work、Codex、登录页、modal 等状态时停止并返回可诊断错误，不盲点。

不触碰凭据：使用用户正常登录后的 App；服务不读取 token/cookie，不保存密码。

可回归：核心 locator/role 都需要 contract test + 版本 smoke test。

版本留痕：每次调用日志包含 ChatGPT App version、adapter、surface signature、MCP server version。

# 4. Phase 0：目标机器能力探测

> **Phase 0 目标**  
> 用最少代码确定“CDP 可否直接控制官方 Desktop”以及“AT-SPI accessibility tree 是否足够完整”。这一阶段不实现 MCP，不写业务逻辑。

## 4.1 环境基线采集

```bash
# OS / session
cat /etc/os-release
uname -a
echo "$XDG_SESSION_TYPE"
echo "$WAYLAND_DISPLAY"
echo "$DISPLAY"

# ChatGPT package/version
command -v chatgpt
chatgpt --version || true
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' chatgpt 2>/dev/null || true

# Running processes
pgrep -a -f 'chatgpt|ChatGPT'
ps -eo pid,ppid,cmd | grep -i '[c]hatgpt'
```

输出写入 `artifacts/probe/<timestamp>/environment.txt`。禁止在日志中输出认证 token、cookie、Authorization header。

## 4.2 CDP 探测

前提：完全退出 ChatGPT App，避免已有主进程忽略新 flag。使用 loopback 地址，禁止将调试端口绑定到 0.0.0.0。

```bash
# 1) 确认 9222 未被占用
ss -ltnp | grep ':9222' || true

# 2) 仅在受控 PoC 中尝试 Chromium 常见 remote debugging flag
chatgpt --remote-debugging-port=9222 2>~/chatgpt-cdp-probe.log &

# 3) 检查本机 discovery endpoint
curl --fail --silent --show-error http://127.0.0.1:9222/json/version
curl --fail --silent --show-error http://127.0.0.1:9222/json/list
```

> **判断标准**  
> 若 discovery endpoint 正常返回、target 可由 Playwright connectOverCDP 枚举，并且可访问 ChatGPT 的可见页面，则标记 CDP_AVAILABLE=true。若 flag 被忽略、端口未监听、target 受限或连接后无法稳定操作，则不要继续猜测内部端点，直接转 AT-SPI。

TypeScript 探测代码（仅证明 attach，不代表 locator 已稳定）

```typescript
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
for (const [ci, context] of browser.contexts().entries()) {
  for (const [pi, page] of context.pages().entries()) {
    console.error({ ci, pi, url: page.url(), title: await page.title() });
  }
}
```

## 4.3 AT-SPI 探测

```bash
sudo apt update
sudo apt install -y accerciser python3-pyatspi at-spi2-core

# 在图形桌面会话内启动
accerciser
```

工程师应在 Accerciser 中选择 ChatGPT 应用，记录以下节点是否存在以及 role/name/state 是否稳定：

- ChatGPT 主窗口/顶层 application frame
- Chat/Work/Codex surface 的可辨识节点
- 消息 composer（可编辑文本接口）
- Send/Stop/Cancel 等 action
- 最后一条 assistant 消息文本节点
- New chat 控件
- conversation/sidebar 条目（P1）
- 模型/推理模式选择器（P1）

建议用截图 + 导出的 accessibility tree 文本建立 `fixtures/atspi/<app-version>/`，作为后续 locator 回归基线。

## 4.4 Phase 0 Go/No-Go 输出

| 结果 | 决策 |
| --- | --- |
| CDP 可用且关键节点稳定 | 采用方案 A；AT-SPI 保留诊断/备用，不必实现完整 P1 |
| CDP 不可用；AT-SPI 关键节点稳定 | 采用方案 B；MCP 主进程 + Python AT-SPI sidecar |
| CDP/AT-SPI 均不可维护 | 采用方案 C Web adapter，Desktop 适配延后 |
| 三者均不可可靠自动化 | 项目停止 UI 路线，使用官方 API / codex mcp-server |
| 合规 Gate 未通过 | 仅保留技术 PoC，不部署持续自动调用 |

# 5. MCP 对外接口设计

## 5.1 Transport

MVP 使用 stdio。理由：Claude Code、Cursor 与本地自定义 Agent 均适合以子进程方式启动本地 MCP server；不需要开放本地 TCP 服务，也减少鉴权与端口暴露面。后续若要多用户/远程，另开 Streamable HTTP 版本，不要把 GUI Desktop 单实例直接共享成未鉴权网络服务。

MCP 规范在 2026-07-28 出现较大版本演进，而 TypeScript v2 SDK 当前仍有 beta/兼容语义。工程上应优先对目标 Claude Code/Cursor 版本做互操作测试；不要为了“最新协议”牺牲客户端兼容。MVP 可以选择目前客户端共同支持的 SDK/protocol 组合，并在 server 启动日志中打印 negotiated/protocol 信息。

## 5.2 Tool 设计

| Tool | MVP | 职责 |
| --- | --- | --- |
| chatgpt_health | 是 | 返回 adapter、App 状态、surface、busy、capabilities；不得泄露凭据 |
| chatgpt_new_chat | 是 | 创建新普通 Chat，并返回 server conversation handle |
| chatgpt_ask | 是 | 原子操作：可选新建/选择会话 → 写 prompt → 发送 → 等待最终 assistant reply → 返回 |
| chatgpt_continue | 是 | 基于 handle 继续会话；本质可调用 ask 的同一内部路径 |
| chatgpt_cancel | 建议 | 仅当当前 generation 明确属于本 server 的 active operation 时取消 |
| chatgpt_list_conversations | P1 | 列出有限数量最近会话；UI 易变，非核心 |
| chatgpt_select_mode | P1 | Instant/Thinking/Pro 等；先能力探测，再开放 enum |
| chatgpt_attach_file | P1 | 上传文件并等待 attachment ready；路径必须受 allowlist 控制 |

## 5.3 推荐的 chatgpt_ask 输入/输出

```text
input:
{
  "prompt": "string",
  "conversation_handle": "optional string",
  "new_chat": false,
  "mode": "auto | instant | thinking | pro | optional",
  "timeout_ms": 180000,
  "request_id": "optional caller-supplied idempotency key"
}

output:
{
  "ok": true,
  "conversation_handle": "cgpt_01J...",
  "message_id": "server-local id",
  "text": "final assistant response",
  "mode_observed": "thinking",
  "adapter": "cdp",
  "app_version": "observed version",
  "started_at": "...",
  "completed_at": "...",
  "duration_ms": 23841,
  "warnings": []
}
```

注意：`conversation_handle` 是本服务维护的稳定句柄，不等同于 ChatGPT 内部 conversation id。只有在 adapter 能稳定获取官方 UI 可见的持久标识时，才把它作为 handle metadata 存储；不得把未公开的认证/网络 token 当成 handle。

## 5.4 Capability discovery

```json
{
  "adapter": "atspi",
  "surface": "chat",
  "capabilities": {
    "ask": true,
    "new_chat": true,
    "continue_chat": true,
    "list_conversations": false,
    "select_mode": ["auto", "thinking"],
    "attach_file": false,
    "cancel_generation": true
  }
}
```

Client 不应假设 P1 能力存在。任何未探测到的能力返回 `UNSUPPORTED_CAPABILITY`，而不是盲目操作 UI。

# 6. 核心领域模型与 Adapter Contract

```typescript
export type AdapterKind = "cdp" | "atspi" | "web";

export interface AdapterCapabilities {
  ask: boolean;
  newChat: boolean;
  continueChat: boolean;
  listConversations: boolean;
  selectModes: string[];
  attachFile: boolean;
  cancelGeneration: boolean;
}

export interface ChatGPTAdapter {
  kind: AdapterKind;

  probe(): Promise<ProbeResult>;
  health(): Promise<AdapterHealth>;

  ensureChatSurface(): Promise<void>;
  newChat(): Promise<ConversationLocator>;

  resolveConversation(handle: ConversationRecord): Promise<ConversationLocator>;
  sendPrompt(locator: ConversationLocator, prompt: string): Promise<SendReceipt>;
  waitForFinalResponse(
    locator: ConversationLocator,
    receipt: SendReceipt,
    options: WaitOptions
  ): Promise<AssistantResponse>;

  cancel?(receipt: SendReceipt): Promise<void>;
  listConversations?(limit: number): Promise<ConversationSummary[]>;
  selectMode?(mode: string): Promise<ModeSelectionResult>;
  attachFile?(path: string): Promise<AttachmentResult>;
}
```

Adapter contract 的关键是把“发送”和“等待最终回复”拆开，便于取消、超时、状态诊断；对外的 `chatgpt_ask` 仍保持原子语义。

## 6.1 Orchestrator 状态机

```text
IDLE
  │
  ├─ acquire global UI lock
  ▼
PREPARE_SURFACE
  ├─ ensure Chat
  ├─ resolve/new conversation
  ▼
READY
  ├─ baseline assistant messages / generation state
  ▼
SENDING
  ├─ set prompt
  ├─ verify composer value
  ├─ trigger send
  ▼
GENERATING
  ├─ detect user message committed
  ├─ observe assistant stream / busy indicator
  ▼
STABILIZING
  ├─ generation ended
  ├─ final text unchanged for debounce window
  ▼
COMPLETED
  └─ persist mapping + release lock

Any unsafe/unknown state → FAILED_DIAGNOSTIC → release lock
```

## 6.2 Conversation store

使用本地 SQLite 或 JSONL（MVP 可 SQLite）保存 server handle 与 adapter locator metadata。建议字段：

| 字段 | 用途 |
| --- | --- |
| handle | 随机/ULID 风格 server 句柄，例如 cgpt_... |
| adapter_kind | cdp / atspi / web |
| app_version_created | 创建时 App 版本 |
| locator_json | adapter 自己解释的可重建 locator，不含凭据 |
| title_hint | 可选，便于人工诊断；不是主键 |
| created_at / last_used_at | 生命周期 |
| status | active / stale / invalid |

若 locator 在 App 更新后失效，`resolveConversation` 可以尝试 title_hint + recency 等无副作用恢复；若存在歧义必须返回 `CONVERSATION_AMBIGUOUS`，不得自动选一个。

# 7. 方案 A：CDP Desktop Adapter

> **适用条件**  
> 只有 Phase 0 证明目标 ChatGPT Desktop 实例可通过 loopback CDP discovery 被稳定附着后才启用。本方案不是 OpenAI 官方公开的 ChatGPT Desktop automation API。

## 7.1 连接策略

- MCP Server 不拥有用户账号登录；ChatGPT Desktop 由用户正常登录。
- 如果需要 remote-debugging flag，使用独立受控启动脚本；端口只绑定 loopback，并在调用结束后不暴露到局域网。
- 不要把 CDP websocket URL 写入共享日志；其权限等价于对该 App renderer 的高权限控制。
- 连接后只操作可见 UI/DOM，不拦截认证请求，不读取 cookie/localStorage 作为业务数据。

## 7.2 Target 选择

不要硬编码 `pages()[0]`。使用“候选 target → surface signature → 唯一匹配”的策略。示例 signature 由以下非敏感特征组合：可见 Chat composer、Chat/Work toggle、消息列表容器、窗口 title。

```typescript
async function selectChatPage(browser: Browser): Promise<Page> {
  const candidates = browser.contexts().flatMap(c => c.pages());

  const scored = [];
  for (const page of candidates) {
    const score =
      (await hasVisibleComposer(page) ? 5 : 0) +
      (await hasChatSurfaceControls(page) ? 3 : 0) +
      (await hasConversationRegion(page) ? 2 : 0);

    if (score > 0) scored.push({ page, score, url: page.url() });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) throw E("SURFACE_NOT_FOUND");
  if (scored.length > 1 && scored[0].score === scored[1].score)
    throw E("SURFACE_AMBIGUOUS");

  return scored[0].page;
}
```

## 7.3 Locator 设计

选择器优先级由稳定性从高到低：

1. 语义 role + accessible name（且 name 不依赖本地化文本时最佳）
1. 产品稳定 data-* / test id（只有通过多个版本验证后使用）
1. 结构关系，例如“message list 中最后一个 assistant article”
1. 显示文本（仅用于辅助判定，必须兼容中文/英文与 A/B 文案）
1. CSS class/hash（最后手段，禁止作为唯一定位）

所有 locator 必须集中在 `adapters/cdp/locators.ts`，不得散落在业务代码。

## 7.4 发送 prompt

```text
1. assert surface == Chat && no blocking modal
2. locate composer
3. focus composer
4. clear only if this is a new unsent draft owned by automation
5. fill(prompt)
6. read composer value back; must equal prompt
7. snapshot:
   - assistant message count
   - last assistant fingerprint
   - generation state
8. trigger Send
9. verify a new user message committed / composer cleared
10. return SendReceipt(baseline, timestamp)
```

第 6 与第 9 步用于防止“看起来发送了但焦点错了”的 silent failure。

## 7.5 完成检测

推荐采用多信号判定，而不是仅等待 Stop button 消失：

| 信号 | 含义 | 权重 |
| --- | --- | --- |
| assistant message count > baseline | 确有新回复节点 | 强 |
| generation/busy indicator seen then gone | 完成流式生成 | 强 |
| new assistant text 非空 | 回复开始 | 中 |
| assistant text 在 750–1500ms 内稳定 | DOM 已稳定 | 中 |
| composer 重新可提交 | UI 回到 idle | 辅助 |

完成条件建议：`new assistant exists` AND `generation not active` AND `text stable >= stabilization_ms`。若超时但文本非空，返回 `GENERATION_TIMEOUT` 并在 error.data 中附带 `partial_text_present=true`；对外不要把部分文本当成功结果。

## 7.6 CDP 安全边界

- remote debugging 端口必须仅为 127.0.0.1；不要暴露到 Docker bridge、LAN 或公网。
- MCP Server 与 ChatGPT Desktop 应运行在同一用户会话；不要以 root 运行。
- 禁止通用 `page.evaluate()` 去扫描所有 storage/cookies；只允许 UI 定位所需 DOM。
- 保留 adapter-level allowlist：只允许 ChatGPT surface target，连接到其他 target 立即拒绝。

# 8. 方案 B：AT-SPI Desktop Adapter

## 8.1 推荐实现形态

推荐 TypeScript MCP 主进程 + Python AT-SPI sidecar。原因：Ubuntu 24.04 直接提供 `python3-pyatspi`，GNOME 维护 pyatspi2；相比寻找不成熟的 Node AT-SPI binding，这条路径更可控（R6、R7）。

```text
Node/TypeScript MCP process
      │ JSON lines over stdin/stdout OR Unix domain socket
      ▼
Python sidecar: atspi_worker.py
      │
      ▼
pyatspi / AT-SPI D-Bus
      │
      ▼
ChatGPT Desktop accessibility tree
```

## 8.2 Sidecar RPC

```text
request:
{"id":"42","method":"probe","params":{}}
{"id":"43","method":"new_chat","params":{}}
{"id":"44","method":"send_prompt","params":{"text":"..."}}
{"id":"45","method":"wait_final","params":{"baseline":{...},"timeout_ms":180000}}

response:
{"id":"44","ok":true,"result":{"receipt":"..."}}
{"id":"45","ok":false,"error":{"code":"GENERATION_TIMEOUT","detail":"..."}}
```

Sidecar stderr 用于诊断日志，stdout 只允许 JSONL RPC，避免破坏 MCP stdio。

## 8.3 Accessibility locator

AT-SPI locator 不应只依赖树 index。推荐组合：application identity + role + interface + state + ancestor signature。

```python
@dataclass
class AccessibleSelector:
    roles: set[str]
    names: list[str] | None
    requires_editable_text: bool = False
    requires_actions: set[str] | None = None
    ancestor_roles: list[str] | None = None
    must_be_showing: bool = True
```

对 composer，优先要求：支持 editable text interface、showing/enabled/focusable；对 message node，要求 text interface + 位于 conversation region。

## 8.4 AT-SPI 操作原则

- 优先调用 Accessibility action/text API，不用 xdotool 模拟全局鼠标坐标。
- 如果控件只有键盘路径，使用 focus + key event 也必须先验证 focus 归属。
- 任何按钮 action 前，记录 element signature 并二次确认窗口仍是 ChatGPT。
- Wayland/XWayland 差异必须进入测试矩阵；必要时 MVP 固定使用官方默认 XWayland 路径，Native Wayland 作为 P1。

## 8.5 响应文本聚合

Accessibility tree 可能把 Markdown 回复拆成多个 text nodes。不要直接串联整个窗口所有 StaticText。推荐：定位最后一个 assistant message 容器 → DFS 收集其可见 textual descendants → 按几何/树顺序合并 → 去除 UI 控件 label。

> **重要**  
> macOS claude-chatgpt-mcp 的一个脆弱点正是从整个窗口 accessibility 内容中提取回复；Linux 版本应把“先定位消息容器”作为设计要求，避免复制同类脆弱性。

# 9. 方案 C：ChatGPT Web Fallback Adapter

当 Desktop CDP 与 AT-SPI 都不可维护时，使用 Playwright 启动专用浏览器 profile 访问 chatgpt.com。它不再是“Desktop App wrapper”，但可以保持 MCP API 与 ChatGPT 产品会话体验的大部分一致。

## 9.1 Profile 策略

```typescript
const context = await chromium.launchPersistentContext(
  process.env.CHATGPT_MCP_PROFILE!,
  {
    headless: false,
    channel: "chrome",
  }
);
```

- 第一次由用户在专用 profile 中人工登录。
- 不要复用日常 Chrome 默认 User Data Directory；Playwright 官方也明确建议创建独立 automation profile。
- profile 目录权限设为 0700；不进入 Git、备份或共享盘。
- 服务不解析 cookie；登录失效时返回 AUTH_REQUIRED，让用户人工恢复。

## 9.2 与 Desktop Adapter 的差异

| 项目 | Desktop CDP/AT-SPI | Web fallback |
| --- | --- | --- |
| 目标产品表面 | 官方 Linux Desktop | chatgpt.com |
| 登录态 | App 内登录 | 专用 Chrome profile |
| 模型/功能一致性 | 以 Desktop rollout 为准 | 以 Web rollout 为准 |
| 自动化 API | CDP/AT-SPI（若可用） | 标准浏览器 DOM |
| 维护风险 | App UI/可访问性变化 | Web DOM/A-B test 变化 |

# 10. 会话、并发、状态与响应完成检测

## 10.1 单实例并发模型

MVP 采用全局 mutex：同一 ChatGPT Desktop 实例同一时刻只允许一个写操作（new_chat/send/select_mode/upload/cancel）。`health` 可并发读，但不得改变 focus。

```typescript
await uiMutex.runExclusive(async () => {
  await adapter.ensureChatSurface();
  const locator = await resolveOrCreateConversation(req);
  const receipt = await adapter.sendPrompt(locator, req.prompt);
  return await adapter.waitForFinalResponse(locator, receipt, waitOptions);
});
```

若用户本人同时操作 ChatGPT App，自动化状态可能被打断。MVP 可选择“自动化调用期间显示桌面通知/托盘 busy 状态”；检测到人工导航或 focus/surface 突变时返回 `USER_INTERFERENCE_DETECTED`。

## 10.2 超时预算

| 阶段 | 默认 | 上限建议 |
| --- | --- | --- |
| surface prepare | 10 s | 30 s |
| conversation resolve/new | 10 s | 30 s |
| prompt commit | 10 s | 30 s |
| generation | 180 s | 由 MCP 调用参数控制；建议 <= 15 min |
| stabilization | 1.0 s | 3 s |

Think/Pro 模式可能显著更慢，因此 generation timeout 必须是业务参数，不要硬编码为 30 秒。

## 10.3 响应 fingerprint

为防止误读旧回复，发送前记录 baseline；新响应需满足“节点新增或 fingerprint 变化且 timestamp 在 send 之后”。fingerprint 可由 message container 稳定属性 + 规范化文本 hash 组成。不得使用网络层私有 message id。

## 10.4 用户中断与取消

- `chatgpt_cancel` 只允许取消 server 当前记录的 active operation。
- 若 UI 显示 Stop 且 active receipt 匹配，执行一次 cancel；随后等待 idle。
- 若无法证明 Stop 属于本次调用，返回 `CANCEL_UNSAFE`，不要点击。
- MCP client 超时/断开时，Server 可按配置选择继续完成并写日志，或安全取消；默认建议取消以释放 GUI。

# 11. 错误模型、恢复策略与幂等

## 11.1 统一错误码

| 错误码 | 含义 | 可自动重试? |
| --- | --- | --- |
| APP_NOT_RUNNING | ChatGPT App 未运行 | 可，若允许 server 启动 App |
| AUTH_REQUIRED | 出现登录/重新认证页面 | 否，需用户操作 |
| SURFACE_NOT_FOUND | 无法确认当前普通 Chat surface | 有限重试 |
| SURFACE_AMBIGUOUS | 多个候选 surface | 否 |
| COMPOSER_NOT_FOUND | 找不到可编辑输入区 | 有限重试/版本回归 |
| PROMPT_COMMIT_FAILED | 写入或发送验证失败 | 只有 request_id 幂等保护后可重试 |
| GENERATION_TIMEOUT | 生成未在 timeout 内完成 | 由调用者决定 |
| RESPONSE_NOT_FOUND | 未找到对应新 assistant 消息 | 有限重试读取，不重新发送 |
| CONVERSATION_STALE | handle locator 已失效 | 尝试无副作用恢复 |
| USER_INTERFERENCE_DETECTED | 用户手工改变了 GUI 状态 | 否，提示重试 |
| UNSUPPORTED_CAPABILITY | adapter 不支持该能力 | 否 |
| ADAPTER_BROKEN | UI 版本变化导致 contract 失败 | 否，触发告警 |
| COMPLIANCE_DISABLED | 配置策略禁止自动化执行 | 否 |

## 11.2 幂等策略

最危险的重试是“客户端没收到结果，于是再次发送 prompt”，会产生重复 ChatGPT 消息。推荐：

- chatgpt_ask 接收可选 `request_id`。
- Server 在发送前创建 operation record；确认 user message committed 后将状态设为 SENT。
- 相同 request_id 再次请求时，如果已 SENT/GENERATING，不再次发送，只尝试读取同一 operation 的结果。
- 若无法判断第一次是否发送成功，返回 `UNKNOWN_COMMIT_STATE`，要求人工/调用者决定，而不是自动重发。

## 11.3 自动恢复边界

允许：重新定位 window/page、重新 focus、等待 modal 消失、重新解析 accessibility tree。

不允许：在未知页面尝试多个按钮、重复点击 Send、自动接受条款/登录/MFA、绕过 rate limit、安全检查或订阅限制。

# 12. 配置、日志、可观测性与安全

## 12.1 配置示例

```yaml
adapter:
  preference: [cdp, atspi, web]
  require_desktop: true

cdp:
  endpoint: http://127.0.0.1:9222
  auto_launch: false

atspi:
  sidecar_command: /usr/bin/python3
  sidecar_args: [/opt/chatgpt-mcp/atspi_worker.py]

timeouts:
  prepare_ms: 10000
  generation_ms: 180000
  stabilization_ms: 1000

security:
  allow_file_roots:
    - /home/user/projects
  redact_prompts_in_logs: true
  compliance_mode: poc_only

state:
  db_path: ~/.local/share/chatgpt-mcp/state.db
```

## 12.2 日志

日志使用 JSONL，stderr 输出。默认不得记录完整 prompt/response；只记录 hash、长度、时间和状态。Debug 模式若需内容，必须显式开启且文档提示敏感性。

```json
{
  "ts":"2026-08-19T19:40:01+09:00",
  "level":"info",
  "event":"operation.completed",
  "request_id":"req_...",
  "adapter":"atspi",
  "app_version":"...",
  "conversation_handle":"cgpt_...",
  "prompt_chars":1240,
  "response_chars":6120,
  "duration_ms":41020
}
```

## 12.3 Metrics

- operation_success_total{adapter,tool}
- operation_failure_total{adapter,error_code}
- operation_duration_ms histogram
- generation_duration_ms histogram
- locator_recovery_total
- user_interference_total
- adapter_probe_success{adapter}
- app_version_seen

## 12.4 安全要求

| 要求 | 实现 |
| --- | --- |
| 最小权限 | 普通用户运行；不要 root |
| 调试端口 | 仅 127.0.0.1；不得公网/LAN |
| 文件上传 | realpath 后校验 allowlist root；拒绝 symlink 越界 |
| 凭据 | 不读取、不导出、不打印 cookie/token/password |
| 日志 | 默认 redaction；0600/0700 权限 |
| MCP server | stdio 优先，不监听网络 |
| 依赖 | 锁定版本、生成 SBOM、定期漏洞扫描 |
| App 更新 | 更新后先跑 smoke test；失败自动 disable adapter |

# 13. 部署与 Claude Code / Cursor 接入

## 13.1 推荐部署方式

MVP 以本地用户级 CLI 包发布，例如 `chatgpt-desktop-mcp`。不建议 systemd system service，因为 GUI accessibility/CDP 需要用户图形会话。若需要守护，使用 `systemd --user`。

```bash
# Example build/install
npm ci
npm run build

# One-time probe
chatgpt-desktop-mcp probe --verbose

# Direct MCP stdio smoke test
npx @modelcontextprotocol/inspector node /opt/chatgpt-mcp/dist/server.js
```

## 13.2 Claude Code 示例

Claude Code 的 MCP 配置格式会随版本演进，工程师应以目标版本官方命令为准。推荐以 stdio command + args 注册，不把 prompt/账号信息写入配置。示意：

```bash
claude mcp add chatgpt-desktop \
  node /opt/chatgpt-mcp/dist/server.js
```

验收时要求 Claude Code 可列出 `chatgpt_health`、`chatgpt_new_chat`、`chatgpt_ask` 等 tool，并完成一次端到端调用。

## 13.3 Cursor / 自定义 Client

采用等价的 stdio MCP server 配置。自定义 Client 应测试 tools/list、tool call error、超时与 server crash 重启。MCP 连接生命周期由 Client 管理，不应另起一个抢占同一 stdin/stdout 的 server 实例。

# 14. 分阶段实施计划

| 阶段 | 目标 | 主要交付物 | Go/No-Go |
| --- | --- | --- | --- |
| Phase 0 | 能力探测 | probe 脚本、CDP/AT-SPI 记录、技术决策 ADR | 至少一条可维护 adapter 路径 |
| Phase 1 | MVP ask | health/new_chat/ask；全局锁；超时；错误码 | 100 次基本调用 >= 98% 成功 |
| Phase 2 | 会话恢复 | conversation handle、continue、SQLite store、幂等 request_id | 重启后继续会话 >= 95% |
| Phase 3 | P1 功能 | list/select mode/file upload（仅通过能力测试者） | 逐项验收 |
| Phase 4 | 硬化 | 自动回归、App version gate、metrics、打包 | 可由非开发者安装运行 |
| Production Gate | 合规/合同确认 | 签字记录、部署边界 | 不通过则不得持续自动化生产使用 |

## 14.1 Phase 1 最小实现顺序

1. 实现 config、logger、error model。
1. 实现 adapter probe 与 health。
1. 实现 `ensureChatSurface()`。
1. 实现 `newChat()`。
1. 实现 `sendPrompt()` 并验证 user message commit。
1. 实现 `waitForFinalResponse()`，先只支持纯文本回复。
1. 接 MCP tool `chatgpt_ask`。
1. 加入全局锁、timeout、request_id operation store。
1. 使用 MCP Inspector、Claude Code、Cursor 各跑一次端到端。

# 15. 测试策略与测试矩阵

## 15.1 测试层次

| 层次 | 内容 |
| --- | --- |
| Unit | 状态机、timeout、error mapping、conversation store、redaction、幂等 |
| Adapter contract | 以 fake DOM/tree fixture 验证 locator 与响应聚合 |
| Desktop smoke | 真实 ChatGPT App；每次 App 更新后运行 |
| MCP interoperability | Inspector + Claude Code + Cursor |
| Soak | 连续调用 100–500 次，观察重复发送、focus 漂移、内存/句柄泄漏 |
| Chaos | 用户点击侧栏、窗口最小化、网络断开、登录失效、生成超时、App 重启 |

## 15.2 必测矩阵

| 维度 | 用例 |
| --- | --- |
| Ubuntu | 24.04 LTS；26.04 LTS |
| Display | 官方默认 XWayland；Native Wayland（实验性，P1） |
| CPU | x64；ARM64 如团队有设备 |
| ChatGPT App | 当前版本；更新后 N+1 版本 |
| Language | 中文 UI / 英文 UI（至少各一） |
| Window | 正常大小；窄窗口；最大化 |
| Prompt | 短文本；中文；多段 Markdown；长输入；代码 |
| Reply | 短；长；Markdown；代码块；带引用/工具状态 |
| Mode | 默认；Thinking/Pro（如果 P1 开放） |
| Interference | 用户切换会话；最小化；modal；登录失效；网络断开 |

## 15.3 核心自动化验收测试

- 发送 100 个固定短 prompt，不得出现重复 user message。
- 每个返回结果必须对应本次 prompt 后的新 assistant message，不能返回上一轮内容。
- 在 20 次长回复中不得因固定 sleep 截断。
- 强制 timeout 后 server 必须释放全局锁，下一次 health 能工作。
- App 更新后 locator contract 若失败，server 应明确 ADAPTER_BROKEN，而不是误点击。
- 日志扫描不得发现认证 token、cookie、完整密码、MFA 内容。

# 16. 验收标准

| 类别 | 验收标准 |
| --- | --- |
| 功能 | health/new_chat/ask/continue 在目标 Ubuntu 环境可重复运行 |
| 正确性 | 零已知重复发送；零已知旧回复误配 |
| 稳定性 | Phase 1 基础 workload 100 次调用成功率 >= 98%，失败必须有结构化错误 |
| 恢复 | App 重启后 health 能恢复；conversation stale 有明确处理 |
| 安全 | stdio 本地；无公网端口；无凭据提取；文件 allowlist |
| 可维护性 | locator 集中管理；adapter contract test；App version 记录 |
| 客户端 | Claude Code 与至少一个其他 MCP client 通过 |
| 合规 | 进入生产前存在明确 Go 决策记录；否则保持 PoC-only |

# 17. 风险清单与缓解措施

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| ChatGPT UI 更新导致 locator 失效 | 高 | 高 | adapter 隔离、版本 smoke、Fail closed、集中 locator |
| CDP flag 不可用/被移除 | 中-高 | 中 | CDP 仅作为 capability；AT-SPI/Web fallback |
| AT-SPI 树不完整 | 中 | 高 | Phase 0 先验；必要时 Web fallback |
| 用户与 Agent 同时操作 GUI | 高 | 中 | 全局锁、surface change detection、busy 提示 |
| 重复发送 | 中 | 高 | request_id、commit verification、unknown state 不自动重试 |
| 长 Thinking 超时 | 中 | 中 | 可配置 timeout、多信号完成检测 |
| 会话 locator 失效 | 高 | 中 | server handle、stale 状态、无歧义恢复 |
| 调试端口被其他进程控制 | 低-中 | 高 | loopback、同用户、短生命周期、权限隔离 |
| 条款/合同不允许 UI 自动提取输出 | 高（个人条款） | 高 | Production compliance Gate；官方 API/codex 替代 |
| 账号 rate limit/产品限制 | 中 | 中 | 不绕过；向 caller 暴露可诊断错误/人工恢复 |

# 18. 生产合规 Gate 与替代路径

> **当前个人 Terms 风险**  
> OpenAI Terms of Use（2026-01-01 生效、截至本文日期仍为当前版本）在“Using our Services / What you cannot do”中明确列出不得自动或程序化提取数据或 Output。本文设计的核心动作正是自动读取 ChatGPT UI 回复并转交给另一个 Agent，因此不能把“技术上能做”误解为“个人订阅下可以生产化做”。

## 18.1 Go/No-Go Checklist

- 确认实际账号类型：个人 Plus/Pro，还是 Business/Enterprise/Edu/其他组织合同。
- 确认适用 Terms / Services Agreement / Order Form 是否允许该具体自动化。
- 如不明确，由组织法务/采购或 OpenAI 支持渠道确认。
- 确认自动化不会被用于绕过 API 计费、rate limits、安全/访问控制。
- 确认不会共享账号凭据给工程师/Agent；每个授权用户按适用规则使用自己的账号。
- 形成书面 Go/No-Go 记录，写明允许的环境、用户、频率与数据范围。

## 18.2 官方替代路径

| 路径 | 优点 | 与本项目差异 |
| --- | --- | --- |
| OpenAI API | 程序化访问是设计目的、接口稳定、可观测性强 | 不是 ChatGPT 产品 UI/会话；计费与模型配置不同 |
| codex mcp-server | OpenAI 官方明确支持“Codex 作为 MCP server”；可被其他 MCP client 调用 | 是 Codex，不是普通 ChatGPT Chat |
| Codex app-server | 官方用于深度产品集成，含 auth/conversation/agent events | 仍属于 Codex 体系 |

如果业务核心需求只是“让 Claude/Cursor 获得一个 OpenAI 第二意见 Agent”，而非必须复用普通 ChatGPT Chat 产品状态，优先采用官方 codex mcp-server。

# 19. 推荐仓库结构与代码骨架

```typescript
chatgpt-desktop-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── tools.ts
│   │   └── schemas.ts
│   ├── core/
│   │   ├── orchestrator.ts
│   │   ├── state-machine.ts
│   │   ├── errors.ts
│   │   ├── mutex.ts
│   │   ├── operation-store.ts
│   │   └── conversation-store.ts
│   ├── adapters/
│   │   ├── interface.ts
│   │   ├── selector.ts
│   │   ├── cdp/
│   │   │   ├── adapter.ts
│   │   │   ├── locators.ts
│   │   │   └── probe.ts
│   │   ├── atspi/
│   │   │   ├── adapter.ts
│   │   │   ├── sidecar-client.ts
│   │   │   └── python/
│   │   │       └── atspi_worker.py
│   │   └── web/
│   │       ├── adapter.ts
│   │       └── locators.ts
│   ├── config/
│   ├── logging/
│   └── security/
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── fixtures/
│   └── smoke/
├── scripts/
│   ├── probe-linux.sh
│   └── smoke.sh
└── docs/
    ├── ADR-001-adapter-selection.md
    ├── compatibility.md
    └── operations.md
```

## 19.1 MCP server 伪代码

```typescript
const adapter = await selectAdapter(config.adapter.preference);
const orchestrator = new ChatGPTOrchestrator(adapter, stores, uiMutex);

server.registerTool("chatgpt_health", healthSchema, async () => {
  return asMcpResult(await orchestrator.health());
});

server.registerTool("chatgpt_ask", askSchema, async (args) => {
  try {
    policy.assertAutomationAllowed();
    const result = await orchestrator.ask(args);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return toMcpToolError(err);
  }
});
```

## 19.2 Adapter 自动选择

```typescript
async function selectAdapter(preference: AdapterKind[]) {
  const diagnostics = [];

  for (const kind of preference) {
    const adapter = createAdapter(kind);
    const probe = await adapter.probe();
    diagnostics.push({ kind, probe });

    if (probe.usable && probe.safeForWriteAutomation) {
      logger.info("adapter.selected", { kind, probe: probe.summary });
      return adapter;
    }
  }

  throw new ChatGPTMcpError("NO_USABLE_ADAPTER", { diagnostics });
}
```

# 20. 工程任务拆分（可直接建 Jira）

| Key | 任务 | 完成定义 | 阶段 |
| --- | --- | --- | --- |
| EPIC-0 | Capability Probe | 实现环境采集、CDP probe、AT-SPI tree 采集；产出 ADR。 | Phase 0 |
| MCP-1 | Server bootstrap | MCP stdio server、tools/list、health skeleton、structured errors。 | Phase 1 |
| CORE-1 | Operation state machine | 全局 mutex、timeout、request_id、operation store。 | Phase 1 |
| ADP-A1 | CDP adapter MVP | 若 probe 通过：target selection、composer、new chat、response detection。 | Phase 1 |
| ADP-B1 | AT-SPI sidecar MVP | 若 CDP 不通过：pyatspi sidecar + JSONL RPC。 | Phase 1 |
| CORE-2 | Conversation store | SQLite handle + locator metadata + stale recovery。 | Phase 2 |
| TEST-1 | MCP interoperability | Inspector、Claude Code、Cursor 端到端测试。 | Phase 1 |
| TEST-2 | App version smoke | 真实 App 版本 smoke + adapter contract fixture。 | Phase 2 |
| OBS-1 | Logging/metrics | redacted JSONL、version logging、failure counters。 | Phase 2 |
| SEC-1 | Security hardening | loopback checks、file allowlist、permissions、secrets scan。 | Phase 3 |
| P1-1 | Mode selection | capability-based Instant/Thinking/Pro selector。 | Phase 3 |
| P1-2 | File attachment | allowlist path + upload ready detection。 | Phase 3 |
| REL-1 | Packaging | npm/package/launcher、systemd --user 可选、install docs。 | Phase 4 |
| GATE-1 | Compliance approval | 确认合同/授权并形成 Go/No-Go 记录。 | Production Gate |

# 附录 A. PoC 命令清单

以下命令用于在目标 Ubuntu 桌面会话中完成 Phase 0。任何输出在分享前应检查并删除敏感信息。

```bash
# A1. System baseline
cat /etc/os-release
uname -m
echo "$XDG_SESSION_TYPE"
echo "$DISPLAY"
echo "$WAYLAND_DISPLAY"

# A2. ChatGPT baseline
command -v chatgpt
chatgpt --version || true
dpkg-query -W chatgpt 2>/dev/null || true
pgrep -a -f 'chatgpt|ChatGPT'

# A3. CDP probe (controlled PoC only)
pkill -f 'chatgpt'   # only if safe and user has saved work
sleep 2
chatgpt --remote-debugging-port=9222 &
sleep 3
ss -ltnp | grep ':9222' || true
curl -sS http://127.0.0.1:9222/json/version || true
curl -sS http://127.0.0.1:9222/json/list || true

# A4. AT-SPI tools
sudo apt update
sudo apt install -y accerciser python3-pyatspi at-spi2-core
accerciser
```

> **PoC 禁止事项**  
> 不要把 9222 暴露到 0.0.0.0；不要抓取/导出 cookie、session token；不要解包/修改 ChatGPT App 来绕过限制；不要自动处理 MFA 或安全验证。

# 附录 B. MCP Schema 示例

```json
{
  "name": "chatgpt_ask",
  "description": "Ask the locally signed-in ChatGPT Desktop Chat surface and return the final assistant message.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "prompt": { "type": "string", "minLength": 1 },
      "conversation_handle": { "type": "string" },
      "new_chat": { "type": "boolean", "default": false },
      "mode": {
        "type": "string",
        "enum": ["auto", "instant", "thinking", "pro"]
      },
      "timeout_ms": {
        "type": "integer",
        "minimum": 10000,
        "maximum": 900000,
        "default": 180000
      },
      "request_id": { "type": "string", "maxLength": 128 }
    },
    "required": ["prompt"],
    "additionalProperties": false
  }
}
```

如果 adapter 的 `selectModes` 不包含 caller 指定 mode，应立即返回 `UNSUPPORTED_CAPABILITY`。Schema 中 enum 是产品层理想值；实际可通过 health capability 再约束。

# 附录 C. 参考资料

- R1. OpenAI, ChatGPT — Release Notes, 2026-08-14 Linux desktop announcement. https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- R2. OpenAI Developers, ChatGPT desktop app for Linux — supported distributions, install/update, Wayland/Ozone notes. https://developers.openai.com/codex/linux/linux-app
- R3. syedazharmbnr1/claude-chatgpt-mcp, README — macOS ChatGPT Desktop MCP features and installation. https://github.com/syedazharmbnr1/claude-chatgpt-mcp
- R4. syedazharmbnr1/claude-chatgpt-mcp, index.ts — MCP stdio layer, AppleScript/JXA implementation, tool schema. https://github.com/syedazharmbnr1/claude-chatgpt-mcp/blob/main/index.ts
- R5. Microsoft Playwright, BrowserType — connectOverCDP / launchPersistentContext documentation. https://playwright.dev/docs/api/class-browsertype
- R6. GNOME, Libatspi and the Python stack — pyatspi2. https://gnome.pages.gitlab.gnome.org/at-spi2-core/devel-docs/atspi-python-stack.html
- R7. Ubuntu Packages (24.04 Noble), accerciser / python3-pyatspi. https://packages.ubuntu.com/noble/all/gnome/accerciser
- R8. OpenAI, Terms of Use, effective 2026-01-01 — restriction on automatically/programmatically extracting data or Output. https://openai.com/policies/row-terms-of-use/
- R9. OpenAI Developers, Use Codex with the Agents SDK / Running Codex as an MCP server. https://developers.openai.com/codex/mcp-server
- R10. Model Context Protocol, TypeScript SDK / protocol evolution references. https://ts.sdk.modelcontextprotocol.io/v2/
- R11. Model Context Protocol, Getting Started / specification. https://modelcontextprotocol.io/docs/getting-started/intro
- R12. OpenAI, OpenAI Services Agreement, effective 2026-01-01 (for Business/Enterprise/APIs; applicability must be confirmed). https://openai.com/policies/services-agreement/

> **文档有效性**  
> ChatGPT Desktop、MCP SDK、Claude Code、Cursor 都处于快速迭代状态。工程团队应把“兼容性验证日期 + ChatGPT App version + adapter”写入 compatibility.md，并在每次 Desktop 更新后重跑 smoke test。

# 结论

从工程结构看，将 macOS claude-chatgpt-mcp 的思想迁移到 Ubuntu 是可行的：MCP Server 不是主要难点，核心风险集中在官方 Linux ChatGPT Desktop 的可自动化表面与产品更新稳定性。正确的工程策略是先探测 CDP，再评估 AT-SPI，最后保留 Web fallback；同时用清晰 Adapter Contract、全局锁、幂等操作记录、多信号完成检测和版本 smoke test 把 UI 自动化的脆弱性限制在可维护范围内。

但生产决策必须与技术决策分离：如果实际使用方式受个人 ChatGPT Terms 的自动/程序化 Output 提取限制约束，应停止将 UI 自动化作为生产后端，并切换至 OpenAI 明确提供的程序化接口（API、codex mcp-server 等）或取得适用授权。
