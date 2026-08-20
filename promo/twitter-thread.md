# X/Twitter Thread: chatgpt-desktop-mcp

## Tweet 1 (Hook + What)
Building MCP servers is my new hobby. Today's build: chatgpt-desktop-mcp 💻

Turns your local ChatGPT Desktop app into an MCP server with 6 tools for Claude Code & Cursor. No API keys needed — just AT-SPI accessibility automation.

Thread 🧵👇

## Tweet 2 (Why This Approach)
Most integrations try to reverse-engineer APIs. That's ethically murky and brittle.

I chose AT-SPI (accessibility protocol) instead. It works like a human agent does: sees the UI, clicks buttons, types text. No cookies, no MFA bypass. Fully compliant with platform boundaries.

## Tweet 3 (The Tech Stack)
- Node.js/TypeScript orchestrator via stdio JSONL
- Python AT-SPI sidecar (pyatspi)
- xdotool for window targeting (WM_CLASS match, never by title)
- Idempotency via request_id + operation store
- Interference detection (blocks on mode switch)

Open source: github.com/cantbeblank96/chatgpt-mcp

## Tweet 4 (Key Guarantees)
✅ Never double-sends prompts (request_id deduplication)  
✅ Fresh reply guarantee (baseline fingerprint detects stale responses)  
✅ Detects user interference mid-call (safe abort)  
✅ Returns RATE_LIMITED when 429 banner appears  

Stress-tested across 100 consecutive rounds (PASS). Chaos scenarios too.

## Tweet 5 (Security Model)
This runs locally on YOUR machine. It:
- Never exports cookies/tokens/passwords
- Doesn't intercept network traffic
- Restores clipboard after every operation
- Logs only prompt/reply lengths by default (opt-in full content)

Your secrets stay yours.

## Tweet 6 (Use Cases)
Imagine workflows like:
- Agent debugging via real ChatGPT history
- Reviewing model outputs in a persistent session
- Cross-referencing multiple turns without re-generation
- Linux-native alternative to web-based MCP clients

What would you build with it?

## Tweet 7 (Call to Action)
Try it → https://github.com/cantbeblank96/chatgpt-mcp

Built this as part of exploring MCP servers + desktop automation. Feedback welcome!

Special thanks to @anthropics for the MCP spec — this whole ecosystem is 🔥

Hashtags: #MCP #ClaudeAI #OpenSource #Linux #AILocal
