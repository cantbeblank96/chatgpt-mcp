# chatgpt-desktop-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](chatgpt-desktop-mcp/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Ubuntu%2022.04%2B-orange)](#)
[![MCP](https://img.shields.io/badge/MCP-stdio-5A2D81)](https://modelcontextprotocol.io)

> **Turn your local, logged-in ChatGPT Desktop (Ubuntu/Linux) into an MCP server**
>
> Expose the official desktop client's normal Chat mode as 6 MCP tools via AT-SPI accessibility.
> For full documentation including quick start, troubleshooting, and usage cautions, see
> [chatgpt-desktop-mcp/README.md](chatgpt-desktop-mcp/README.md).
>
> ⚠️ **Technical Validation PoC** (`compliance_mode: poc_only`). Completed 100-round stability validation,
> but still considered experimental software. Not affiliated with OpenAI.

---

## Overview

Drives the official desktop app via **AT-SPI accessibility**. Key guarantees:

- **Idempotent**: `request_id` + operation store prevents duplicate sends
- **Fresh reply guarantee**: baseline fingerprints detect stale responses
- **Interference-safe**: detects user switching conversations/modes mid-call
- **Rate-limit aware**: returns `RATE_LIMITED` when the server responds with 429
- **Stress-tested**: 100 consecutive rounds PASS, chaos injection scenarios 4/4

Full technical details, testing commands, security notes, known limitations,
and a detailed troubleshooting table are available in [chatgpt-desktop-mcp/README.md](chatgpt-desktop-mcp/README.md).

---

## Quick Start

```bash
git clone https://github.com/cantbeblank96/chatgpt-mcp.git
cd chatgpt-mcp/chatgpt-desktop-mcp
npm install && npm run build
```

Register with Claude Code / Cursor using examples under [`examples/`](chatgpt-desktop-mcp/examples/).
See configuration templates and complete troubleshooting in [README.md](chatgpt-desktop-mcp/README.md).

完整中文设计文档：[`notes/Ubuntu_ChatGPT_Desktop_MCP_Server_技术设计方案_v1.0.md`](notes/Ubuntu_ChatGPT_Desktop_MCP_Server_技术设计方案_v1.0.md)。
