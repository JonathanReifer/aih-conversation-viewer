# Plan: Git Init + Display Overhaul + Loki/OTEL Data Source

## Context

`pai-conv-viewer` is a single-file Bun/TypeScript server (`src/server.ts`, 248 lines) running on port 4446. It currently reads `~/.llm-privacy/prompts.jsonl` but has a critical grouping bug and no multi-user support.

**Branding:** Generic — "Conversation Viewer" / "AI Conversations". No product-specific labels.

**Critical bug (current):** All 223 JSONL entries share `sessionId: "unknown"`. The code groups by sessionId so only 1 session appears. The 41 real sessions are undetectable from the JSONL alone.

**Why Loki solves this better:**  
The OTEL stack (already running at `http://localhost:3100`) stores Claude Code telemetry with *proper session UUIDs* in `attributes["session.id"]` and *user identity* in `attributes["user.email"]`. This is the right source for session grouping and user filtering. The Loki data contains:

| Event body | Key attributes |
|------------|----------------|
| `claude_code.user_prompt` | `prompt`, `prompt.id`, `session.id`, `user.email`, `event.sequence` |
| `claude_code.api_request` | `model`, `cost_usd`, `input_tokens`, `output_tokens`, `duration_ms`, `session.id`, `user.email` |
| `claude_code.internal_error` | `error_code`, `error_name`, `session.id`, `user.email` |
| `claude_code.hook_execution_complete` | `hook_event`, `num_hooks`, `total_duration_ms`, `session.id` |

Loki stream labels: `{job="claude-code", level="info"|"error", service_name="claude-code"}`

**Limitation noted:** Loki has prompts and API metadata but NOT full AI response text. The content view will show user prompts and API turn metadata (model, cost, duration, tokens). If full response content is needed later, that's a separate track.

---

## Task 1 — Git Init

- `git init` in `/home/compadmin/Projects/pai-conv-viewer`
- Create `.gitignore`:
  ```
  node_modules/
  *.log
  .env
  *.pid
  ```
- Initial commit with all current files

---

## Task 2 — Replace Data Source: JSONL → Loki

Replace the entire server data layer. Remove `LOG_PATH` / `readLogEntries()` / `groupBySessions()` in favour of a Loki HTTP client.

### Loki client (`server.ts` additions)

```typescript
const LOKI_URL = process.env.LOKI_URL ?? "http://localhost:3100";
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? "30");
```

**`queryLoki(query, startNs, endNs, limit)`** — wraps `GET /loki/api/v1/query_range`, returns parsed `LokiEntry[]`:

```typescript
type LokiEntry = {
  ts: string;           // ISO from nanosecond timestamp
  body: string;         // e.g. "claude_code.user_prompt"
  attributes: Record<string, unknown>;
  level: "info" | "error";
}
```

**`fetchAllEvents(userFilter?: string)`** — queries `{job="claude-code"}`, fetches up to 5000 entries, parses JSON log lines. If `userFilter` provided, post-filters on `attributes["user.email"]`.

**`buildSessions(events)`** — groups by `attributes["session.id"]`, returns `Session[]`:

```typescript
type Session = {
  id: string;           // attributes["session.id"] UUID
  user: string;         // attributes["user.email"]
  firstTs: string;
  lastTs: string;
  model: string;        // last api_request model
  totalCost: number;    // sum of cost_usd across api_request events
  totalTokens: number;  // sum of input+output tokens
  promptCount: number;  // count of user_prompt events
  hasErrors: boolean;
}
```

### API endpoints (same paths, new implementation)

- `GET /api/sessions` → `{ sessions: Session[], total, availableUsers: string[] }`  
  - `availableUsers` = distinct `user.email` values across all sessions
- `GET /api/sessions?user=email@example.com` → filtered list
- `GET /api/sessions/{sessionId}` → full event timeline for session

  Response shape:
  ```typescript
  type SessionDetail = {
    id: string;
    user: string;
    model: string;
    totalCost: number;
    events: TimelineEvent[];
  }
  type TimelineEvent =
    | { kind: "prompt"; ts: string; text: string; sequence: number }
    | { kind: "api"; ts: string; model: string; cost: number; inputTokens: number; outputTokens: number; durationMs: number }
    | { kind: "error"; ts: string; code: string; message: string }
```

---

## Task 3 — User Filter UI

When `availableUsers.length > 1`:
- Show a compact filter row under the "Conversations" header
- Buttons: "All" (default) + one per user email (truncated: `businessadmin@…`)
- Active button highlighted; clicking re-fetches and re-renders sessions
- Session rows show a small `user` badge when "All" is active

When only 1 user: filter row is hidden.

---

## Task 4 — Improved Conversation Display

### Session list sidebar

Each `.session-row` now shows:
- Timestamp (last activity)
- **First prompt text** (truncated to ~70 chars) as session title
- Badges: model · prompt count · cost (`$0.05`) · error badge (if `hasErrors`)
- User badge (when All filter active)

### Session detail view

**Timeline** replaces the old message bubbles:

**Prompt events** (user turns) — styled as user message bubble:
```
USER   12:04:17
What does this code do? I want to extend it to support…
```

**API request events** (assistant turns) — styled as a compact metadata card:
```
✦ claude-sonnet-4-6  ·  1.2s  ·  3,456 tok  ·  $0.02
```
(Not a bubble — a thin accent line with metadata, like a system message)

**Error events** — red callout:
```
⚠ ECONNABORTED  ·  12:04:19
```

**Thread header** gains:
- Session UUID (truncated, copyable on click)
- Total cost for session
- "Expand all / Collapse all" toggle (for any tool cards that appear if we later add JSONL content)

### JSONL tool display (kept as fallback)

The existing `renderContent()` is improved but kept for any sessions that still come from JSONL. Preview extraction:

| Tool | Preview |
|------|---------|
| `Bash` | First line of `block.input.command` |
| `Read` | `block.input.file_path` |
| `Write`/`Edit` | `block.input.file_path` |
| `Agent` | `block.input.description` |
| `WebFetch`/`WebSearch` | `block.input.url` or `block.input.query` |
| other | First 80 chars of `JSON.stringify(block.input)` |
| `tool_result` | First line of content |

---

## Files Modified

| File | Changes |
|------|---------|
| `src/server.ts` | All changes — new Loki client, new API impl, new HTML/CSS/JS |
| `.gitignore` | New file |

No new files needed — the server remains a single self-contained TypeScript file.

---

## Env Vars

| Var | Default | Purpose |
|-----|---------|---------|
| `LOKI_URL` | `http://localhost:3100` | Loki base URL |
| `LOOKBACK_DAYS` | `30` | How far back to query |

---

## Verification

1. `git log --oneline` — initial commit exists
2. `bun src/server.ts` — starts cleanly
3. Open `http://localhost:4446` — sidebar shows multiple sessions (real UUIDs, not "unknown")
4. Sessions show first prompt text and cost badges
5. Click session — timeline shows user prompts as bubbles and API events as metadata lines
6. When only 1 `user.email` in data: no filter row shown
7. If OTEL data from a second user were present: filter row appears, filtering works
