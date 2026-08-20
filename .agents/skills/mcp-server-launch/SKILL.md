---
name: mcp-server-launch
description: When the user wants to launch, promote, or announce an MCP server (like chatgpt-desktop-mcp). Use when mentioning "MCP server," "model context protocol," "Claude Code MCP," "Cursor MCP," "agent tools," "AI automation," "Claude MCP launch," "MCP announcement," etc. Also use for Product Hunt launches of MCP servers, GitHub visibility optimization, X/Twitter threads, Reddit posts (r/MachineLearning, r/ClaudeAI, r/LocalLLaMA), and developer community announcements. Coordinate with **github** skill for repo SEO/GEO; **product-hunt-launch**, **reddit-posts**, **twitter-x-posts** for multi-platform promotion.
metadata:
  version: 1.0.0
---

# Platform: MCP Server Launch

Guides launching and promoting Model Context Protocol (MCP) servers. MCP is an emerging standard for connecting AI assistants (Claude Code, Cursor, custom agents) to external tools/services via a unified interface. Best for: developer tools, desktop automation, API wrappers, data connectors, AI productivity enhancers.

**When invoking**: On **first use**, if helpful, open with 1–2 sentences on what this skill covers and why it matters (MCP adoption is accelerating; visibility in dev communities drives early adopters), then provide the main output. On **subsequent use** or when the user asks to skip, go directly to the main output.

## Why MCP Servers Are Hot

| Factor | Effect |
|--------|--------|
| **Ecosystem growth** | Claude Code + Cursor natively support MCP; new clients adding daily |
| **Low friction** | Single stdio JSONL protocol; no auth complexity vs REST APIs |
| **Community-driven** | GitHub trending, r/MCP_Maker, Discord servers actively discovering new servers |
| **Network effect** | Each star/fork exposes the server to thousands of developers |
| **GEO opportunity** | ChatGPT, Perplexity cite popular MCP repos for technical queries |

## Pre-Launch Checklist (7 Days Before)

| Task | Priority | Notes |
|------|----------|-------|
| **README polish** | 🔴 | Full docs (what it does, quick start, troubleshooting, security); badges (license, tests) |
| **Examples folder** | 🟠 | `examples/*.mcp.json` templates for Claude Code, Cursor; copy-paste ready |
| **Test evidence** | 🟠 | Unit tests green, E2E smoke, stress run summary in CHANGELOG.md |
| **License & Contributing** | 🟢 | MIT license, clear contribution guidelines |
| **Topics metadata** | 🟢 | 6-20 relevant topics (mcp, ai-tools, desktop-automation, ubuntu, etc.) |
| **GitHub About section** | 🟢 | ~128 chars keyword-rich; Website field set |
| **Hunter preparation** | 🟡 | Decide self-hunt vs Top Hunter on Product Hunt |

## Launch Channels Matrix

| Channel | Effort | Reach | Best For | Skill Coordination |
|---------|--------|-------|----------|-------------------|
| **Product Hunt** | High | Homepage features drive 500-800+ upvotes if well-prepared | SaaS, developer tools, AI | Follows **product-hunt-launch** playbook |
| **GitHub Trending** | Medium | Depends on launch day velocity | OSS, CLI tools, libraries | Use **github** for about/topics/README |
| **X/Twitter thread** | Low-Medium | Viral potential via AI/Dev threads | Quick storytelling | Use **twitter-x-posts** |
| **Reddit posts** | Medium | Targeted audiences (r/ClaudeAI, r/LocalLLaMA, r/MachineLearning) | Deep-dive tech discussions | Use **reddit-posts** |
| **Discord/Slack** | Low | Niche but engaged (MCP Maker Discord, Cursor community) | Early feedback | Manual announcement |
| **Hacker News** | Medium | High-quality traffic if "Show HN" format fits | Technical depth | Not covered by existing skills |

## Messaging Framework

### Tagline Formulas (≤60 chars)

| Formula | Example |
|---------|---------|
| **"Turn [X] into [Y]"** | Turn your local ChatGPT Desktop into an MCP server |
| **"Expose [X] as [Y] via [Z]"** | Expose the official desktop client's normal Chat mode as 6 MCP tools via AT-SPI |
| **"Desktop automation MCP for [X]"** | Desktop automation MCP for Ubuntu/Linux chat interfaces |

### First Comment / Thread Hook

**Story-driven narrative** (not feature list):

> *"I needed my local AI agent to talk to my logged-in ChatGPT Desktop app without reverse-engineering the API. Built an MCP server using accessibility protocols (AT-SPI) that works like a 'human proxy' — sends prompts, reads responses, manages sessions. No cookies, no MFA bypass, just pure GUI automation. Open-sourced because others building on Linux should have the same option."*

### Key Selling Points

| Category | What to Highlight |
|----------|------------------|
| **Technical approach** | Accessibility protocol (AT-SPI) vs. CDP/API; why it's compliant |
| **Security guarantees** | Never exports cookies/tokens; runs locally; clipboard restored |
| **Evidence** | Stress-tested across 100 rounds; chaos injection scenarios pass |
| **Use cases** | Agent workflows requiring access to local chat apps without web UI |
| **Constraints honestly stated** | Requires X11 session; only Plain Chat mode; known limitations documented |

## Launch Day Sequence

| Time (Pacific) | Action |
|----------------|--------|
| **11:45 PM** | Final sanity check (build passes, examples work) |
| **12:01 AM** | Publish on GitHub, tag v0.1.0, enable issues/discussions |
| **12:05 AM** | Post first comment on PH (story-driven, not link-heavy) |
| **12:15 AM** | X thread live; tag @anthropics, @claudeai, @cursor_shots |
| **12:30 AM** | Reddit post (r/ClaudeAI first, cross-post later if allowed) |
| **1-2 PM** | Monitor comments; reply to every question personally |
| **All day** | Pin top comments; engage with Hunter supporters |

## Community Engagement

| Platform | Do | Avoid |
|----------|-----|-------|
| **GitHub Issues** | Reply within hours; ask clarifying questions before suggesting workarounds | Ignore stale issues (signals neglect) |
| **PH Comments** | Thank every supporter; answer technical questions in maker replies | Begging for upvotes ("Please support!") |
| **Reddit** | Provide detailed follow-ups; share debug logs if asked | Auto-pasting README sections |
| **X Threads** | Quote-tweet your own thread with updates ("Just hit #stars"); retag different accounts each time | Replying with same tags repeatedly |

## Metrics That Matter

| Metric | Good | Great | Note |
|--------|------|-------|------|
| **Product Hunt upvotes** | 200-400 | 500-800+ | Top 10 / Product of the Day respectively |
| **GitHub stars (24h)** | 50-100 | 200+ | Depends on topic competitiveness |
| **Weekly active users** | N/A | Track via `npm run probe` success rate in production | Harder to measure for local-only tools |
| **Issue quality** | 3-5 thoughtful questions/PRs per week | 10+ high-signal contributions | Indicates real usage |

## Related Skills

- **product-hunt-launch**: Full PH preparation plan (tagline, gallery, first comment)
- **github**: Repo SEO, topics, description, GEO practices for AI citation
- **reddit-posts**: r/ClaudeAI, r/LocalLLaMA, r/MachineLearning post formats
- **twitter-x-posts**: 6-8 tweet thread structure, tagging strategy
- **directory-submission**: MCP directories (mcp.chat, mcp-marketplace.com)
- **cold-start-strategy**: Full 30-day pre-launch campaign
- **indie-hacker-strategy**: Indie hacker audience positioning (first 100 users)

## Output Format

For **MCP server launch**, always provide:

- **Readiness checklist** (README polish, examples, test coverage, tags)
- **Tagline options** (≤60 chars; 3 variants)
- **First comment draft** (PH style, story-driven, ≤200 words)
- **Launch timeline** (7 days pre-lab → launch day → post-launch)
- **Platform-specific assets** (X thread outline, Reddit post body, PH image specs)
- **Community engagement plan** (reply templates for issues/comments)
