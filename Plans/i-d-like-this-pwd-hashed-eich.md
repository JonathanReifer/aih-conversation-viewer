# Plan: E2E Feature Verification — Conversation Viewer

## Context

All 8 features have been implemented (and repeatedly patched). Multiple bugs were found
post-implementation: JS regex escaping blanked the thread panel, toggle state was being
persisted in localStorage across broken iterations causing OTEL to show nothing, CSS
hide rules didn't cover `.msg.user`. Rather than trust the code, run a live browser
pass through every feature using Interceptor and fix anything that fails.

**Server:** `http://localhost:4446` — Bun/TypeScript, single file `src/server.ts`
**Live data:** 15 unified sessions, 13 OTEL-only, 4 proxy-only
**Good test session (has prompts + PII):** `2026-06-11T14:37:55.087Z` (unified, 20 prompts, 8 PII hits)

---

## Test Sequence (Interceptor)

Execute each step in order, screenshot after each state change.

### Setup
```
interceptor open "http://localhost:4446"
interceptor screenshot
```
**Pass:** Sidebar shows session list. Thread shows "← Select a conversation to view". No JS errors in console.

---

### T1 — Session loads and shows content (Unified)
Click the first session (`2026-06-11T14:37:55.087Z`).
```
interceptor act <session-row-ref>
interceptor screenshot
```
**Pass:** Thread panel fills with message bubbles. Header shows model badge + "219 msgs".
**Fail signals:** Thread is empty, or JS error in console (`interceptor eval "document.querySelectorAll('.msg').length"`).

---

### T2 — Theme toggle (F6)
Click `☀` button (top-right of sidebar).
```
interceptor act <theme-btn-ref>
interceptor screenshot
```
**Pass:** Background switches to light grey/white. Text readable. Button changes to `🌙`.
Click again → back to dark.

---

### T3 — Event filter toggles (F2)
With a session loaded, click "Tools" filter button.
```
interceptor act <tools-btn-ref>
interceptor screenshot
```
**Pass:** All `.tl-tool` cards disappear instantly (no reload). "Tools" button loses highlight.
Click "Prompts" → `.msg.user` bubbles disappear.
Click both back on → both return.
**Fail signals:** Nothing hides, or clicking causes full reload with empty thread.

---

### T4 — OTEL source tab (F1 — hooks/system events)
Click "⚡ OTEL" tab, then click a session with prompts (e.g. `5e821df5`).
```
interceptor act <otel-tab-ref>
interceptor act <session-ref>
interceptor screenshot
```
**Pass:** Thread shows a mix of: prompt bubbles (`.tl-prompt`), API cost bars (`.tl-api`), tool cards (`.tl-tool`), hook cards (`⚙ hookName`), system dividers (`◈ compaction`).
**Check hook count:** `interceptor eval "document.querySelectorAll('.tl-hook').length"` — should be >0.
**Fail signals:** Thread empty, or only prompt/api/tool events visible and no hook/system cards.

---

### T5 — Toggle hooks off in OTEL view
Still on OTEL session, click "Hooks" filter button.
**Pass:** All `⚙` hook cards hide. Click back on → they return.

---

### T6 — Time range selector (F8)
Switch back to Unified. Set "From" date to today's date (`2026-06-11`) in the date-from input.
```
interceptor act <date-from-ref> "2026-06-11"
```
Wait for session list to reload.
**Pass:** Session count drops (only today's sessions show). Set From back to 30-days-ago → full list returns.
**Fail signals:** Session count unchanged, or "0 sessions" with a valid date.

---

### T7 — Sidebar search / global filter (F7)
Type "plan" in the sidebar search input.
**Pass:** Session list filters live to only sessions whose firstPrompt contains "plan". Clear → full list returns.

---

### T8 — In-conversation search (F7)
Load a session. Click `🔍` button or press Ctrl+F.
Type "the" (common word).
**Pass:** Search bar appears. Matches highlighted in yellow (`mark.search-hit`). Count shows "1 of N". ↓/↑ navigate between hits.
`interceptor eval "document.querySelectorAll('mark.search-hit').length"` → should be >0.

---

### T9 — PII navigation (F5)
Load session `2026-06-11T01:20:29.574Z` (55 PII hits).
**Pass:** `🔒` button visible in thread header. Click it → first PII mark scrolls into view and gets `.pii-active` highlight. Click again → advances to next hit.
`interceptor eval "document.querySelectorAll('.pii-hit').length"` → should be ~55.
**Fail signals:** No marks, or button click does nothing.

---

### T10 — Input source labels (F4)
Load a proxy or unified session. Look at user messages.
**Pass:** Some user messages show a small green `typed` badge (short messages) or blue `context` badge (long messages with headers).
`interceptor eval "document.querySelectorAll('.msg-source').length"` → should be >0.

---

### T11 — Session fragmentation (F3)
Compare proxy vs unified session counts.
`curl http://localhost:4446/api/sessions?source=proxy` → expect 4 sessions (not 8+).
If unified shows more sessions than OTEL for the same time window, check if proxy sessions are being over-split.

---

## Fix Strategy

After each failing test, find the root cause before moving on:

| Likely failure | Where to look |
|----------------|---------------|
| Thread empty after click | `loadSession()` L812 — check `!r.ok` silent return; check `renderOtelEvent`/`renderUnified` |
| Toggles don't hide | CSS `body.hide-*` rules L658–666; `toggleKind()` L854 |
| OTEL has no hook cards | `buildOtelTimeline()` — hook_execution_start branch; check actual Loki data has those events |
| PII marks not appearing | `scanPii()` L1283 — check `setTimeout` fires; check PII_PATTERNS against actual text |
| Search bar doesn't open | `toggleSearch()` L1206; check `#search-bar` CSS `display: none` vs `.open` |
| Theme doesn't persist | `localStorage.getItem('theme')` at page load — present in init block? |

---

## Execution Order

1. Run Interceptor test sequence T1–T11 in one session
2. Screenshot evidence for each step
3. Fix any failing features immediately (targeted edits to `src/server.ts`)
4. Re-test fixed features
5. Commit with summary of what passed/failed/fixed

---

## Files

- `src/server.ts` — sole file; all fixes go here
- `Plans/i-d-like-this-pwd-hashed-eich.md` — this file

## Verification

All 11 test cases pass with screenshot evidence. `curl /api/sessions?source=proxy` returns ≤5 sessions.
