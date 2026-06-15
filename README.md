# aih-conversation-viewer

Session viewer for AI coding harnesses. Browse every conversation that passed through
the `aih-security` stack — prompts in chat-bubble layout, tool decisions, PII findings,
and MITRE ATLAS security events, all in one timeline per session.

Runs entirely on your machine at `http://localhost:4446`. No cloud dependency, no accounts.

---

## What it shows

| Tab | Data source | What you see |
|-----|-------------|--------------|
| **Proxy** | `~/.llm-privacy/prompts.jsonl` | Conversations logged by aih-privacy-proxy: user/assistant turns, tokenized PII counts, security decisions (allow / ask / block), ATLAS findings |
| **OTEL** | Loki HTTP (`$LOKI_URL`) | Structured hook telemetry from aih-observability: tool calls, hook timings, API costs, token counts, model names |
| **Unified** | Both sources correlated | Combined timeline merging proxy conversation and OTEL hook events into a single chronological view per session |

The Proxy tab works without any observability stack. The OTEL and Unified tabs require
`aih-observability` to be running and `LOKI_URL` to be set.

---

## Requirements

- [Bun](https://bun.sh) runtime (`bun --version` → 1.x)
- `aih-privacy-proxy` running and logging to `~/.llm-privacy/prompts.jsonl` (for Proxy tab)
- `aih-observability` stack (for OTEL and Unified tabs) — optional

No npm packages. No Node.js. Pure Bun runtime, single file.

---

## Installation

The `aih-security` unified installer handles this at Step 6.6:

```bash
bash ~/Projects/aih-security/install.sh
# → "Install aih-conversation-viewer?" [Y/n]
```

### Manual install

```bash
cd ~/Projects
git clone https://github.com/JonathanReifer/aih-conversation-viewer.git
```

No `bun install` needed — zero external dependencies.

---

## Starting the server

### One-time (foreground)

```bash
bun ~/Projects/aih-conversation-viewer/src/server.ts
# → Listening on http://localhost:4446
```

### Daemon mode

```bash
bash ~/Projects/aih-conversation-viewer/start.sh
# → [conv-viewer] started (pid=12345) — http://localhost:4446
```

`start.sh` is idempotent — running it twice does nothing if the server is already up.

PID file: `/tmp/pai-conv-viewer.pid`
Log file: `/tmp/pai-conv-viewer.log`

### Stop the daemon

```bash
kill $(cat /tmp/pai-conv-viewer.pid)
rm /tmp/pai-conv-viewer.pid
```

---

## Environment variables

| Variable | Default | What it does |
|----------|---------|--------------|
| `LOG_PATH` | `~/.llm-privacy/prompts.jsonl` | Path to the proxy conversation log (JSONL) |
| `LOKI_URL` | `http://localhost:3100` | Loki endpoint for the OTEL and Unified tabs |
| `LOOKBACK_DAYS` | `30` | How far back to load sessions (days) |

Set them in `~/.llm-privacy/.env.sh` so they apply to both the proxy and the viewer:

```bash
# ~/.llm-privacy/.env.sh
export LOKI_URL=http://localhost:3100
export LOOKBACK_DAYS=60
```

Then start:

```bash
source ~/.llm-privacy/.env.sh
bun ~/Projects/aih-conversation-viewer/src/server.ts
```

Or inline:

```bash
LOKI_URL=http://192.168.1.10:3100 LOOKBACK_DAYS=90 \
  bun ~/Projects/aih-conversation-viewer/src/server.ts
```

---

## API

The server exposes two endpoints consumed by the embedded SPA — you can also call them
directly for scripting or debugging.

### `GET /api/sessions?source=proxy|otel|unified&start=ISO&end=ISO`

Returns an array of session summaries.

```bash
curl -s http://localhost:4446/api/sessions?source=proxy | python3 -m json.tool
```

Example response item:

```json
{
  "id": "2026-06-14T18:30:00.000Z",
  "source": "proxy",
  "firstTs": "2026-06-14T18:30:00.000Z",
  "lastTs": "2026-06-14T19:15:22.000Z",
  "firstPrompt": "fix the null check in auth.ts",
  "model": "claude-sonnet-4-6",
  "messageCount": 12,
  "piiCount": 0
}
```

### `GET /api/sessions/:id?source=proxy|otel|unified`

Returns full detail for one session: all messages, tool events, hook timings, findings.

```bash
curl -s "http://localhost:4446/api/sessions/2026-06-14T18:30:00.000Z?source=proxy" \
  | python3 -m json.tool
```

---

## Session segmentation (Proxy source)

Proxy sessions are reconstructed from the JSONL log. Entries within a **90-minute gap**
are grouped into one session. A new session starts when more than 90 minutes pass between
log entries.

The conversation view picks the log entry with the most tokenized turns as the canonical
message list for each session, so short follow-up prompts don't fragment the display.

---

## Connecting to aih-observability

The OTEL and Unified tabs need Loki. The `aih-observability` stack provides it.

### Local stack (same machine)

```bash
cd ~/Projects/aih-observability
docker compose up -d

export LOKI_URL=http://localhost:3100
bun ~/Projects/aih-conversation-viewer/src/server.ts
```

### Remote stack

```bash
export LOKI_URL=http://<server-ip>:3100
bun ~/Projects/aih-conversation-viewer/src/server.ts
```

See [aih-observability](https://github.com/JonathanReifer/aih-observability) and
[aih-security/docs/observability.md](https://github.com/JonathanReifer/aih-security/blob/main/docs/observability.md)
for full setup.

---

## Troubleshooting

**Proxy tab shows no sessions**

The log file is missing or empty.

```bash
# Check the log exists and has entries:
wc -l ~/.llm-privacy/prompts.jsonl

# Check the proxy is running and logging:
curl -s http://localhost:4444/health | python3 -m json.tool
# → "vaultMode" should be "sqlite", not "memory"
```

If `LOG_PATH` was overridden, make sure the viewer is started with the same value.

**OTEL/Unified tabs show no sessions**

Loki isn't reachable or has no data yet.

```bash
# Verify Loki is up:
curl -s http://localhost:3100/ready
# → "ready"

# Check LOKI_URL matches where you started the viewer:
echo $LOKI_URL

# Check there are logs in Loki:
curl -s "http://localhost:3100/loki/api/v1/labels" | python3 -m json.tool
```

If the observability stack was just started, run a Claude Code session first to populate
Loki with hook telemetry.

**`bun: command not found` when running start.sh**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bash ~/Projects/aih-conversation-viewer/start.sh
```

Add the export to your `~/.bashrc` or `~/.zshrc` to make it permanent.

**Port 4446 already in use**

```bash
lsof -i :4446
kill <PID>
```

Or check if the daemon is already running:

```bash
cat /tmp/pai-conv-viewer.pid
```

**Conversations show tokenized placeholders (`[TOKEN_abc123]`)**

The viewer displays conversations as the proxy logged them — with PII/secret tokens
instead of the original values. This is expected. The proxy vault holds the real values;
the log only stores tokens. The security decision and findings columns show what was
detected, even if the raw text is redacted.

---

## Integration with the aih-security installer

The installer (`aih-security/install.sh`) includes the viewer as Step 6.6. It:

1. Clones this repo into `~/Projects/aih-conversation-viewer`
2. Adds a `SessionStart` hook entry to `~/.claude/settings.json` that calls `start.sh`
   so the viewer starts automatically when Claude Code opens
3. Prints the URL (`http://localhost:4446`) in the installer summary

If you ran the installer and skipped the viewer prompt, you can install it manually:

```bash
cd ~/Projects
git clone https://github.com/JonathanReifer/aih-conversation-viewer.git

# Then add the SessionStart hook to ~/.claude/settings.json:
# "command": "bash $HOME/Projects/aih-conversation-viewer/start.sh"
```

---

## File layout

```
aih-conversation-viewer/
├── src/
│   └── server.ts    # Bun HTTP server + embedded SPA (single file, ~1500 lines)
├── start.sh         # Daemon launcher (nohup, PID tracking)
└── package.json     # name: pai-conv-viewer, no dependencies
```
