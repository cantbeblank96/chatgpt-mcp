# chatgpt-desktop-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Ubuntu%2022.04%2B-orange)](#)
[![MCP](https://img.shields.io/badge/MCP-stdio-5A2D81)](https://modelcontextprotocol.io)

**Turn your local, logged-in ChatGPT Desktop app (Ubuntu/Linux) into an MCP server** —
expose the official desktop client's normal Chat mode as MCP tools for
Claude Code / Cursor / any MCP client.

**把本机已登录的官方 ChatGPT Desktop（Ubuntu/Linux）变成 MCP Server**，
供 Claude Code / Cursor / 任意 MCP Client 调用。

> ⚠️ **Technical Validation PoC** (`compliance_mode: poc_only`).
> Completed 100-round stability validation, but still considered experimental software.
> Please do not use for bypassing login/MFA/rate limits or bulk scraping; confirm
> applicable OpenAI terms separately before production use.

---

**English** | [中文](#中文说明)

## Features

- 6 MCP tools: health / new chat / ask / continue / cancel / list conversations
- Drives the **official desktop app via AT-SPI accessibility** — no reverse engineering,
  no cookies/tokens, no network interception
- **Idempotency & anti-duplicate-send**: `request_id` + operation store + commit verification
- **Fresh-reply guarantee**: never returns a stale response (baseline fingerprint + new-message check)
- Robust against GUI reality: message-list virtualization, user interference detection,
  rate-limit (429) banners, IME preedit interference — all handled
- Battle-tested: **Stress-tested across 100 consecutive rounds (PASS); chaos scenarios 4/4 passed**, unit tests 14/14

## Architecture

```text
Claude Code / Cursor / Custom Agent
        │  MCP (stdio)
        ▼
chatgpt-desktop-mcp (Node.js/TypeScript)
        │  JSONL over stdio
        ▼
Python pyatspi sidecar (atspi_worker.py)
        │  AT-SPI accessibility + clipboard + xdotool
        ▼
Official ChatGPT Desktop on Ubuntu
```

Why AT-SPI? CDP is disabled in the app's production build (renderer-level commands
unresponsive) — see [docs/ADR-001-adapter-selection.md](docs/ADR-001-adapter-selection.md).

## Quick Start

### 1. Prerequisites

- Ubuntu 22.04+ (X11 session; Wayland not supported)
- Node.js ≥ 18
- System Python 3 with `gi` (bundled with Ubuntu Desktop; otherwise
  `sudo apt install python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0`)
- `xdotool` (`sudo apt install xdotool`)
- Official ChatGPT Desktop (deb install), logged in

### 2. Launch ChatGPT with the a11y flag

The Chromium renderer does not expose its accessibility tree by default:

```bash
chatgpt --force-renderer-accessibility
```

Without this flag, `chatgpt_health` / `probe` return `ADAPTER_BROKEN` with a
restart hint. **This project never silently kills or restarts the ChatGPT process.**

### 3. Build & verify

```bash
git clone https://github.com/cantbeblank96/chatgpt-mcp.git
cd chatgpt-mcp/chatgpt-desktop-mcp
npm install
npm run build
npm test                 # offline unit tests
npm run probe            # verify a11y access to the running app (needs GUI session)
```

### 4. Register with your MCP client

<details open>
<summary><b>Claude Code</b> — project-level <code>.mcp.json</code></summary>

```json
{
  "mcpServers": {
    "chatgpt-desktop": {
      "command": "node",
      "args": ["/absolute/path/to/chatgpt-desktop-mcp/dist/main.js"]
    }
  }
}
```

</details>

<details>
<summary><b>Cursor</b> — <code>~/.cursor/mcp.json</code> or project <code>.cursor/mcp.json</code></summary>

```json
{
  "mcpServers": {
    "chatgpt-desktop": {
      "command": "node",
      "args": ["/absolute/path/to/chatgpt-desktop-mcp/dist/main.js"]
    }
  }
}
```

</details>

Runnable examples: see [chatgpt-desktop-mcp/examples/](examples/) directory for configuration templates.

### 5. Use it

```jsonc
// chatgpt_ask
{
  "prompt": "Explain KV cache in one sentence",
  "new_chat": true,
  "request_id": "task-42-step-1",   // always provide one for idempotency
  "timeout_ms": 180000
}
```

Response:

```jsonc
{
  "ok": true,
  "conversation_handle": "cgpt_0679dcf5eb792699",
  "message_id": "m_3f9a…",
  "text": "……",
  "adapter": "atspi",
  "duration_ms": 17353,
  "warnings": []
}
```

Use `chatgpt_continue` with the same `conversation_handle` for follow-up turns.

## Usage Cautions / 使用提醒

- **Window & clipboard**: each call briefly **activates the ChatGPT window** and
  temporarily occupies the clipboard (restored afterwards). Avoid typing elsewhere
  at the exact moment of a call.
  调用期间会短暂激活 ChatGPT 窗口并占用剪贴板（用后恢复），调用瞬间避免同时进行其他输入操作。
- **Pacing**: keep **≥25s between consecutive asks** to avoid OpenAI rate limits
  (a 429 banner surfaces as `RATE_LIMITED`).
  连续提问建议间隔 ≥25 秒，避免触发 OpenAI 账号限流。
- **Hands off during a call**: manually switching conversations/modes mid-call
  triggers `USER_INTERFERENCE_DETECTED` and the call aborts safely — retry after
  the app settles.
  调用期间不要手动操作 ChatGPT 窗口；如触发干扰检测，等界面稳定后重试。
- **IME**: a Chinese-mode IME can swallow synthetic keys; the sidecar pre-clears
  preedit with Escape automatically. If typing still misbehaves, switch the IME
  to English mode.
  输入法处于中文模式时 sidecar 会自动 Escape 清理 preedit；若仍异常，切英文模式重试。

## MCP Tools

| Tool | Description |
| --- | --- |
| `chatgpt_health` | Read-only health check: app process, a11y flag, chat surface, composer, current mode |
| `chatgpt_new_chat` | Start a new conversation; returns an MCP-maintained `conversation_handle` (`cgpt_*`) |
| `chatgpt_ask` | Send a prompt and wait for **this turn's new reply** (the core tool) |
| `chatgpt_continue` | Continue within a `conversation_handle` (fingerprint-verified) |
| `chatgpt_cancel` | Press Stop on an in-flight generation; no-op (`cancelled=false`) when idle |
| `chatgpt_list_conversations` | Read-only enumeration of visible sidebar conversation titles (virtualized list) |

## Correctness Design

- **Never double-send**: `request_id` + operation store + commit verification.
  Retrying the same `request_id` never re-sends; a succeeded request replays its
  result verbatim; when delivery cannot be confirmed, `UNKNOWN_COMMIT_STATE` is
  returned for manual review.
- **Never return stale replies**: a message baseline (fingerprint/count/existing
  error banners) is recorded before sending; afterwards a **new** assistant message
  must appear and the last user message must equal the committed prompt.
  (The message list is virtualized — long conversations render only the last ~14
  messages — so detection uses structural conditions, not absolute counts.)
- **Completion is not a fixed sleep**: `new assistant message present AND generation
  stopped (Stop button gone + status bar) AND text stable for stabilization_ms
  (default 1000ms)`.
- **Global mutex**: the GUI is a single shared mutable device; all writes are
  serialized. Exception: `chatgpt_cancel` bypasses the mutex so it can actually
  interrupt a long `ask` that holds the lock (the sidecar is single-threaded and
  serial, so this is concurrency-safe).
- **User interference detection**: if the conversation is switched / the mode
  changes / the latest message isn't our prompt during a wait, the call returns
  `USER_INTERFERENCE_DETECTED` (requires ≥2 consecutive observations — debounced);
  it never blindly keeps clicking.
- **Window targeting by WM_CLASS**: activation matches `--classname ChatGPT`
  exactly — never by window title (a browser tab with the same title would
  otherwise receive keystrokes).
- **Server-side rate limiting**: a **new** error banner during the wait
  (e.g. "Request failed with status 429") returns `RATE_LIMITED`; stale banners
  present before sending are ignored.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `CDGMCP_PYTHON` | `/usr/bin/python3` | Sidecar interpreter (must be system Python with `gi` — not conda) |
| `CDGMCP_WORKER_SCRIPT` | built-in | Override `atspi_worker.py` path |
| `CDGMCP_ASK_TIMEOUT_MS` | `180000` | Default ask timeout |
| `CDGMCP_STABILIZATION_MS` | `1000` | Reply text stabilization window |
| `CDGMCP_POLL_INTERVAL_MS` | `500` | Poll interval while waiting for a reply |
| `CDGMCP_STATE_DIR` | `~/.local/share/chatgpt-mcp` | Operation/conversation store directory (0700) |
| `CDGMCP_LOG_LEVEL` | `info` | debug/info/warn/error |
| `CDGMCP_LOG_FULL_CONTENT` | unset | Set to `1` to log full prompts/replies |

## Testing

```bash
npm test                 # 14 offline unit tests
npm run test:smoke       # real-GUI E2E: initialize → list → health → new_chat →
                         #   ask → continue → idempotent replay of the same request_id
node tests/smoke/e2e-chaos.mjs    # chaos: cancel mid-generation, timeout releases the mutex
node tests/smoke/stress-100.mjs   # 100-round stress driver (segmented, resumable)
```

Test reports (100-round acceptance, Phase 3 capability + injection) are kept
locally; summary results live in [CHANGELOG.md](CHANGELOG.md).
*Note: E2E tests require a running ChatGPT Desktop instance with accessibility enabled.*

## Security

- MCP runs over **stdio only** — no network ports, no root.
- Never reads/exports cookies, tokens or passwords; never reverse-engineers the OpenAI API.
- Logs record prompt/reply **lengths** by default, never content
  (opt in with `CDGMCP_LOG_FULL_CONTENT=1`).
- Local state files (`operations.json` / `conversations.json`) are 0600; directory 0700.
- Your clipboard is saved before pasting and **restored afterwards**.
- After an app update, re-run `npm run probe` and `npm run test:smoke` as regression.

## Known Limitations

- Requires an X11 session and `--force-renderer-accessibility`; no Wayland / headless.
- Briefly activates the ChatGPT window and occupies the clipboard during automation
  (clipboard is restored).
- Message parsing relies on the `你说：` / `ChatGPT 说：` headings and paragraph
  nodes in the accessibility tree (zh + en); rich text (code blocks, quotes) is
  returned as concatenated plain text.
- Single instance, single window, serialized by design; parallelism would require
  multiple instances/profiles (not implemented).
- Rapid consecutive asks may hit OpenAI account rate limits (UI shows a 429 banner;
  `RATE_LIMITED` is returned). This is a server-side constraint, not a bug —
  in practice, ≥25s between turns runs stably.
- Mode switching (Instant/Thinking/Pro) and file upload are **not implemented**:
  they failed the capability test (the mode popup has no visible/accessible a11y
  nodes; upload requires the native file dialog). See the Phase 3 report.

## Troubleshooting

| Symptom | Cause & Fix |
| --- | --- |
| `ADAPTER_BROKEN` on probe/health | App not started with `--force-renderer-accessibility` — restart it with the flag |
| `gi` import error from the sidecar | Wrong interpreter (e.g. conda). Set `CDGMCP_PYTHON=/usr/bin/python3` |
| Typing/paste appears to fail | IME in Chinese mode swallows synthetic keys (preedit). Fixed in v0.1.0 via an Escape pre-clear; keep the app window unobstructed |
| `USER_INTERFERENCE_DETECTED` | You interacted with the app mid-flight — retry after the app settles |
| `RATE_LIMITED` | OpenAI throttling — wait and slow down your request cadence |
| **probe fails / timeouts** | App not started with `--force-renderer-accessibility`; or session is Wayland (X11 required) — check with `echo $XDG_SESSION_TYPE` |
| **clipboard not restored** | In rare cases may need manual intervention; verify clipboard history |
| **gitignore 中仍含 artifacts/** | artifacts/ 探测证据本地保留；确认 `.gitignore` 已加入 `artifacts/`

## Repository Layout

```text
src/
  main.ts                    # entry: MCP stdio server / probe subcommand
  mcp/    server.ts tools.ts schemas.ts
  core/   orchestrator.ts mutex.ts errors.ts
          operation-store.ts conversation-store.ts
  adapters/
    interface.ts             # ChatGPTAdapter abstraction
    atspi/adapter.ts sidecar-client.ts
    atspi/python/atspi_worker.py   # the only component touching AT-SPI/xdotool
  config/ logging/
tests/unit/                  # offline unit tests
tests/smoke/e2e-smoke.mjs    # real-GUI E2E smoke
tests/smoke/e2e-chaos.mjs    # chaos injection
tests/smoke/stress-100.mjs   # 100-round stress driver
scripts/worker_repl.py       # manual sidecar debugging
scripts/audit_conv.py        # virtualization-safe conversation audit
docs/ADR-001-adapter-selection.md
```

---

## 中文说明

本项目通过 **AT-SPI 无障碍接口**驱动本机已登录的官方 ChatGPT Desktop，
将其普通 Chat 模式封装为 6 个 MCP tools。核心保证：

- **绝不重复发送**：`request_id` 幂等 + 操作存储 + 提交验证
- **绝不返回旧回复**：发送前记录基线指纹，必须出现**新的** assistant 消息
- **完成判定非固定 sleep**：结构条件 + 文本稳定窗口
- **全局互斥**：GUI 是共享设备，写操作串行（cancel 例外，可直达中断）
- **干扰检测**：用户手动切会话/切模式时安全返回，绝不盲目继续点击

完整中文设计文档：[`notes/Ubuntu_ChatGPT_Desktop_MCP_Server_技术设计方案_v1.0.md`](../notes/Ubuntu_ChatGPT_Desktop_MCP_Server_技术设计方案_v1.0.md)。

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and capability-test evidence
for new ChatGPT Desktop versions are especially welcome.

## License

[MIT](LICENSE) © xukaiming. This project is not affiliated with or endorsed by OpenAI.
ChatGPT is a trademark of OpenAI, Inc.
