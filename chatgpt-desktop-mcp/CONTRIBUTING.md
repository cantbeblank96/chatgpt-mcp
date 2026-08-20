# Contributing

Thanks for your interest! This project drives a live GUI application, so changes
to the automation layer must be validated against the real app, not just offline tests.

## Development Setup

1. Ubuntu 22.04+ (X11), Node.js ≥ 18, `xdotool`, system Python 3 with `gi`.
2. Launch the official ChatGPT Desktop with `--force-renderer-accessibility`.
3. `npm install && npm run build`

## Validation Ladder (run in order)

| Level | Command | What it proves |
| --- | --- | --- |
| 1 | `npm test` | Offline logic (orchestrator, stores, schemas) |
| 2 | `npm run probe` | a11y access to the running app |
| 3 | `npm run test:smoke` | Real-GUI E2E of all tools (actually talks to ChatGPT) |
| 4 | `node tests/smoke/e2e-chaos.mjs` | Cancel / timeout / mutex recovery |

## Automation Hard Rules

These are hard-won lessons — violating them breaks real users' desktops:

- **Never match windows by title.** Always use WM_CLASS
  (`xdotool search --classname ChatGPT`). Title matching can hit unrelated
  browser tabs and send keystrokes to the wrong app.
- **Prefer semantic AT-SPI actions** (`do_action('press')`) over coordinate
  clicks; coordinate clicks are a last resort and require verified focus.
- **IME safety**: synthetic keystrokes can be swallowed by an active Chinese
  IME preedit. `m_composer_set` sends `Escape` before clear/paste — keep this.
- **Never kill or restart the user's ChatGPT process** without explicit
  confirmation.
- **Clipboard**: always save before pasting and restore afterwards.

## Reporting Bugs

Include: app version, `npm run probe` output, `CDGMCP_LOG_LEVEL=debug` logs
(sanitize any content), and which validation level fails. For UI-change
regressions after a ChatGPT update, a screenshot of the affected area helps.

## New Capabilities

New tools must pass a **capability test** against the real app before being
wired into the MCP layer (precedent: mode switching and file upload were
rejected this way in v0.1.0 — see CHANGELOG.md).
