# pi-ollama-cloud-usage

Pi TUI footer + threshold notifications for **Ollama Cloud usage**, using only
the API key — **no browser cookies, no Chrome, no keyring**.

```
5h ▕██████░░░░▏ 65%  7d ▕████████░░▏ 94%   ctx 42% glm-5.2
```

A drop-in alternative to [`@entelligentsia/pi-ollama-cloud-usage-tracker`](https://github.com/Entelligentsia/pi-ollama-cloud-usage-tracker),
which scrapes `ollama.com/settings` via Chrome cookies. This extension instead
calls the same undocumented `GET https://ollama.com/api/usage` endpoint that the
[`fleet quota`](https://github.com/elecnix/pi-agents) skill wraps, authenticating
with the Ollama Cloud API key Pi already stores in `~/.pi/agent/auth.json`.

## Features

- **Footer status line** (TUI, when `ollama-cloud` is the active provider):
  - `5h` session (5-hour window) usage bar
  - `7d` weekly (7-day window) usage bar
  - `$` extra-usage balance bar (only when Ollama reports one)
  - Bars colored by absolute threshold: green < 50%, accent 50–79%, yellow 80–89%, red ≥ 90%
  - Token stats + context % + active model on the same line, cwd + git branch above it
- **Threshold notifications** (TUI **and** RPC mode — never a tool call, never
  enters LLM context):
  - **session & weekly**: a notification at every 10% increment (10, 20, … 100%)
  - **extra-usage balance**: a notification only at **80%** and **95%**
  - Notifications remain enabled in non-TUI (`pi --mode rpc`) mode via `ctx.ui.notify`
- **Window-reset aware**: when usage drops below the last-notified threshold
  (the rolling window reset), thresholds re-arm so the next climb notifies again
- **First-run seeding**: a session that starts with usage already high seeds
  the threshold state to the current floor silently — no spam of historical
  thresholds on startup
- **No browser dependency**: works headless, in CI, on servers, and on machines
  without Chrome

## Install

```bash
pi install git:github.com/elecnix/pi-ollama-cloud-usage
```

Or from a local clone (Pi auto-discovers `~/.pi/agent/extensions/`):

```bash
git clone https://github.com/elecnix/pi-ollama-cloud-usage.git ~/.pi/agent/extensions/pi-ollama-cloud-usage
```

Try without installing:

```bash
pi -e ./index.ts
```

## Setup

The extension reuses the Ollama Cloud API key configured for the `ollama-cloud`
provider. If you already use [`pi-ollama-cloud`](https://github.com/fgrehm/pi-ollama-cloud)
or ran `/login` → **Ollama Cloud**, you're done. Otherwise set it via env or
`~/.pi/agent/auth.json`:

```json
{ "ollama-cloud": { "type": "api_key", "key": "your-key" } }
```

```bash
export OLLAMA_API_KEY="your-key"
```

Get a key at <https://ollama.com/settings/keys>.

## Configuration

Optional JSON config (project-local overrides global):

| Location | Scope |
| --- | --- |
| `~/.pi/agent/ollama-cloud-usage.json` | Global / user-level |
| `.pi/ollama-cloud-usage.json` | Project-local (takes precedence) |

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `alwaysShowFooter` | boolean | `false` | Render the footer even when `ollama-cloud` is not the active provider |
| `intervalMs` | number | `300000` (5 min) | Refresh interval, clamped to a minimum of 30s |

Example:

```json
{ "alwaysShowFooter": true, "intervalMs": 120000 }
```

## Commands

| Command | Description |
| --- | --- |
| `/ollama-usage` | Refresh and notify the current session/weekly/extra percentages |

## How it works

1. Reads the API key from `$OLLAMA_API_KEY` or `~/.pi/agent/auth.json` (`ollama-cloud.key`).
2. Calls `GET https://ollama.com/api/usage` with `Authorization: Bearer <key>`.
3. Parses `limits.session.usage` and `limits.weekly.usage` (0–1 fractions of the
   plan cap) into percentages; defensively probes for an extra-usage balance.
4. Renders the footer (TUI) and emits threshold notifications (TUI + RPC).
5. Refreshes on startup, every `intervalMs`, and after each `agent_end`.

### Caveats

- The `/api/usage` endpoint is **undocumented** ([ollama/ollama#15663](https://github.com/ollama/ollama/issues/15663),
  [#16448](https://github.com/ollama/ollama/issues/16448)) and could change. The
  extension treats any fetch failure as "unreadable this cycle" and retries on
  the next tick — it never crashes the session.
- The endpoint **does not expose reset timestamps**, so the footer shows no
  countdown (unlike the cookie-scraping variant, which reads them from the
  settings page HTML). Coloring is by absolute threshold, not by pace.
- An **extra-usage balance** field is only present for accounts that purchased
  one (Pro/Max). The parser probes `limits.extra.usage`, `limits.overage.usage`,
  `extra.usage`, `overage.usage`, `balance.usage`, and `activity.balance.usage`
  defensively; if none are present, no extra bar or notification is emitted.

## Development

```bash
npm install
npm run lint       # biome
npm run typecheck  # tsgo --noEmit
npm run test       # vitest
```

## License

MIT