# Changelog

All notable changes to this project are documented here.

## [0.1.0] - 2026-08-20

First public release — technical feasibility PoC, fully validated.

### Added

- 6 MCP tools over stdio: `chatgpt_health`, `chatgpt_new_chat`, `chatgpt_ask`,
  `chatgpt_continue`, `chatgpt_cancel`, `chatgpt_list_conversations`
- Python AT-SPI sidecar (`atspi_worker.py`) driven over JSONL stdio
- Idempotency: `request_id` + operation store + commit verification
  (never double-sends; replays return the original result)
- Fresh-reply guarantee with baseline fingerprints; virtualization-safe
  completion detection (structural conditions + tail fingerprint +
  lastUserPrompt anchor)
- Global mutex for all GUI writes, with `chatgpt_cancel` intentionally bypassing it
- Structured errors: `ADAPTER_BROKEN`, `UNKNOWN_COMMIT_STATE`,
  `GENERATION_TIMEOUT`, `GENERATION_CANCELLED`, `GENERATION_IN_PROGRESS`,
  `RATE_LIMITED`, `USER_INTERFERENCE_DETECTED`, `CONVERSATION_STALE`, …
- Probe subcommand (`npm run probe`) with actionable `ADAPTER_BROKEN` hints
- Test suite: 14 offline unit tests, real-GUI E2E smoke (8 checks),
  chaos injection (4 scenarios), 100-round stress driver (segmented/resumable)

### Hardening (from 100-round stress + chaos testing)

- Stale 429 banners ignored; only new banners raise `RATE_LIMITED`
- Interference detection debounced (≥2 consecutive observations)
- U+FFFC object-replacement characters stripped from extracted text
- IME safety: `Escape` pre-clear cancels active IBus preedit before
  composer clear/paste (Chinese-mode IME otherwise swallows synthetic keys)
- Window activation matches WM_CLASS (`--classname ChatGPT`), never title
- Clipboard saved/restored around every paste

### Known not-implemented

- Mode switching (Instant/Thinking/Pro) and file upload — failed capability
  tests (no accessible popup nodes / native file dialog). See Phase 3 report.

[0.1.0]: https://github.com/cantbeblank96/chatgpt-mcp/releases/tag/v0.1.0
