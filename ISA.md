---
project: aih-conversation-viewer
effort: E3
phase: verify
progress: 30/30
mode: algorithm
started: 2026-07-02
updated: 2026-07-02
---

## Problem

`aih-conversation-viewer/src/server.ts` calls `readProxyEntries()` and `readAuditEntries()` on every HTTP request. Each does a full `readFileSync` + `.split("\n")` + per-line `JSON.parse` of `~/.llm-privacy/prompts.jsonl` (2.8GB, 33,539+ lines on devops1) and `audit.jsonl`, with zero caching. This causes repeated multi-GB in-memory blowups under concurrent/polling load, confirmed as the direct cause of 5 kernel OOM-kills on devops1 in the last ~14 hours (`sudo dmesg -T`), the most recent of which killed this exact server process (PID 1327404) mid-session.

## Vision

`aih-conversation-viewer` runs indefinitely on both devops1 and devops2 without RSS growth per request. New log lines appear in the UI within one poll cycle without a restart. The fix is proven correct via golden-diff (identical API output old vs. new code) and proven scalable via an RSS-flatness loop test, on devops2, before it ever touches devops1 again.

## Out of Scope

- Bounding/rotating `prompts.jsonl` growth at the source (`aih-privacy-middleware`) — out of scope, a separate future fix.
- Swap-size increase on devops1 — explicitly declined by the user.
- `oom_score_adj` tuning — explicitly declined by the user.
- Retention/pruning of the in-memory parsed cache — deferred; `prune` extension point included but unused in v1.
- Any work on `aih-comms` or projects outside the aih-security stack.

## Principles

- Fix the root cause (uncached re-parse), not the symptom (host OOM tuning).
- Zero behavioral change to existing call sites — the fix is an internal cache, not an API redesign.
- Never risk moving real sensitive prompt content across hosts for testing.

## Constraints

- `readProxyEntries()` / `readAuditEntries()` must keep their exact existing signatures and return semantics — 5+ call sites depend on them.
- No new runtime dependencies — `bun test` only, matching this repo's zero-dependency test posture.
- devops2 must be fully verified (golden-diff + RSS-loop) before any redeploy to devops1.
- Never copy devops1's real `~/.llm-privacy/prompts.jsonl` to devops2 — synthetic fixture only.

## Goal

Replace the uncached full-file re-read in `readProxyEntries()`/`readAuditEntries()` with an incremental byte-offset tail cache (`src/logCache.ts`), verify it via `bun test` and a devops2 golden-diff + RSS-flatness pass, then redeploy to devops1 and confirm RSS stays flat against the real 2.8GB log with no new `dmesg` OOM entries.

## Criteria

- [x] ISC-1: `src/logCache.ts` exists and exports `createJsonlTailCache<T>()`
- [x] ISC-2: `bun test` suite covers cold read of N valid lines
- [x] ISC-3: `bun test` suite covers malformed JSON line skipped without breaking subsequent lines
- [x] ISC-4: `bun test` suite covers incremental append — previously-returned entries are reference-identical (`===`) across calls
- [x] ISC-5: `bun test` suite covers partial trailing line invisible until completed
- [x] ISC-6: `bun test` suite covers copy-truncate rotation (`size < byteOffset`) detected and reset
- [x] ISC-7: `bun test` suite covers inode-change rotation detected and reset
- [x] ISC-8: `bun test` suite covers missing-file-at-cold-start returns `[]` without throwing
- [x] ISC-9: `bun test` suite covers transient-missing-after-data returns last-known-good
- [x] ISC-10: `readAuditEntries(startTs, endTs)` date-filter still narrows correctly on top of the shared cache
- [x] ISC-11: `server.ts`'s `readProxyEntries()`/`readAuditEntries()` are thin wrappers around `createJsonlTailCache` instances with unchanged signatures
- [x] ISC-12: pre-warm call (both caches) executes before `Bun.serve()` and logs entry counts + elapsed ms
- [x] ISC-13: `package.json` has `"test": "bun test"` script
- [x] ISC-14: `bun test` passes locally pre-deploy (superseded by ISC-20: 26/26 passing on `26f2cf6`, includes two-tier split suite)
- [x] ISC-15: golden-diff on devops2 — old vs. new code against identical synthetic fixture returns identical JSON across all 4 endpoints (root-caused the entry-count gap: old-code never wires `pruneEntries`, new-code does via `LOOKBACK_DAYS=30` — confirmed expected, not a regression; re-ran both with `LOOKBACK_DAYS=36500` + isolated `AUDIT_LOG_PATH` + mock-Loki responder on :9999 — zero diffs across `/api/sessions`, `/api/security/stats`, `/api/security/events`, and `/api/sessions/:id` for both newest and oldest sessions)
- [x] ISC-16: live-append-while-running test on devops2 — new fixture lines appear via `/api/sessions` without a server restart (appended 1 line to fixture.jsonl while port-4497 kept running; total went 500→501, new session visible immediately with correct content, zero restart)
- [x] ISC-17: RSS-loop test on devops2 (new-code, port 4497) — RSS plateaus (not grows) across 20-30 requests after warm-up (PID 2303885: 70.7MB cold → 76-77MB after warm-up, then flat ± jitter across 25 rounds x 3 endpoints — no unbounded growth, nowhere near the multi-GB OOM signature)
- [x] ISC-18: Anti: devops1's real `prompts.jsonl` is never copied to or read from devops2 during testing (synthetic fixture generated in-place on devops2 via `gen-fixture.ts`)
- [x] ISC-19: devops1 post-redeploy — pre-warm log line reports sane entry count against the real 2.8GB file (34,368-34,416 entries across redeploys, ~15-18s), RSS stays flat across repeated requests (sawtooth floor ~1.22-1.24GB across 38 real requests post-fix, no monotonic growth), `sudo dmesg -T` shows no new OOM kill of the conv-viewer process (still 6 total, last at Jul 2 11:52:12, none since)
- [x] ISC-20: `bun test` passes on `26f2cf6` (two-tier split) — 26/26
- [x] ISC-21: `pruneEntries`/`LOOKBACK_DAYS` retained as secondary safeguard on the index tier (cheap now — ~500B/entry not ~87KB)
- [x] ISC-22: byte offsets recorded correctly on cold read (logCache.test.ts)
- [x] ISC-23: byte offsets recorded correctly across incremental appends (logCache.test.ts)
- [x] ISC-24: UTF-8-straddling-chunk-boundary regression test proves exact round-trip (logCache.test.ts)
- [x] ISC-25: `readExactBytes` valid-range and out-of-bounds/missing-path cases (logCache.test.ts)
- [x] ISC-26: `readExactBytes` against a rotated file at a stale offset returns `null`, never throws (logCache.test.ts + proxyLog.test.ts)
- [x] ISC-27: manual `/api/sessions/:id` fetch for a non-tail (older, early-fixture) synthetic session against new-code (port 4497) proves the on-demand byte-seek hydration path works against historical byte ranges (fetched oldest of 500 synthetic sessions, `2026-06-01T00:05:21.626Z`; 3-message detail identical byte-for-byte to old-code's output)
- [x] ISC-28: manual rotation-trigger test (rename-swap fixture) against new-code confirms a now-stale session id 404s cleanly, not a crash or wrong content (pre-rotation: 200 with full content; rename-swapped in an unrelated 1-session fixture; post-rotation same id: clean 404, server stayed alive, correctly serving new fixture's 1 session)
- [x] ISC-29: Anti: test-instance teardown — ports 4498/4497 and `/tmp/proxylog-verify/{old,new}-code` worktrees removed, leaving devops2's real production instance (PID 2070082, port 4446) untouched (both test PIDs + mock-loki killed, both worktrees removed, `git worktree list` shows only the main checkout, production instance confirmed running + `/api/sessions` returns 200)
- [x] ISC-30: newly-discovered-during-ISC-19-verification bug fixed — `queryLoki()`'s `fetch()` in `server.ts` had no error handling, so one slow/timing-out Loki page (real Loki observed flapping `/ready` 503↔ready under production load — devops2's mock Loki always responds instantly and could never have surfaced this) threw an uncaught rejection that hung the entire `/api/sessions` request until Bun's own 10s `idleTimeout` killed the connection (`HTTP:000` to clients). Fixed with a try/catch around both the `fetch()` and `res.json()` calls (returns `[]` on any failure, mirroring the existing `if (!res.ok) return [];` sibling), a shorter 4s per-page `AbortSignal.timeout` (was 15s — exceeded Bun's own connection timeout), and a 6s wall-clock budget across `fetchOtelEvents`'s whole pagination loop as a second layer of defense. Verified: root-caused via a standalone reproduction script (bypassing Bun.serve) that caught the exact uncaught `TimeoutError` on page 2 against real Loki data; post-fix, `bun test` 26/26 still passes, and 38 real `/api/sessions` requests against production Loki on devops1 all returned `HTTP:200` (previously intermittently hung/timed out)

## Test Strategy

| ISC | Type | Check | Threshold | Tool |
|-----|------|-------|-----------|------|
| ISC-1 | file | logCache.ts exists, exports factory | present | Read |
| ISC-2..10 | unit | bun test suite | all pass | Bash `bun test` |
| ISC-11 | code | call sites unchanged | 0 diffs at call sites | Grep/Read |
| ISC-12 | log | pre-warm line present | logged before listen | Bash / Read log |
| ISC-13 | file | package.json script | present | Read |
| ISC-14 | test | bun test | exit 0 | Bash |
| ISC-15 | diff | old vs new JSON | identical | Bash diff |
| ISC-16 | live | append + poll | new entries visible | Bash + curl |
| ISC-17 | perf | RSS samples | plateau | Bash ps loop |
| ISC-18 | anti | fixture only, no real file transfer | true throughout | manual audit of commands run |
| ISC-19 | live | devops1 post-deploy | sane counts, flat RSS, no new OOM | Bash + dmesg |
| ISC-30 | live | Loki-resilience fix on devops1 | 38/38 real `/api/sessions` requests HTTP:200, `bun test` 26/26 | Bash + curl loop |

## Features

| name | description | satisfies | depends_on | parallelizable |
|------|--------------|-----------|------------|----------------|
| logCache-module | createJsonlTailCache factory | ISC-1 | — | no |
| logCache-tests | bun test suite | ISC-2..10 | logCache-module | no |
| server-refactor | wrap readProxyEntries/readAuditEntries + pre-warm | ISC-11,12 | logCache-module | no |
| local-verify | bun test + package.json script | ISC-13,14 | logCache-tests, server-refactor | no |
| devops2-e2e | fixture, golden-diff, live-append, RSS-loop | ISC-15,16,17,18 | local-verify | no |
| devops1-redeploy | pull, restart, RSS + dmesg check | ISC-19 | devops2-e2e | no |

## Decisions

- 2026-07-02: Chose incremental byte-offset tail cache over mtime-gated whole-file cache (the `project.ts` precedent) because the log only grows — O(new bytes) beats O(file size) on every read as the file scales past GB size.
- 2026-07-02: Deferred retention/pruning — v1 keeps full parsed history in memory forever. Unbounded but currently tens of MB, far below the multi-GB OOM signature. `prune` extension point included, unused, for future bounded retention.
- 2026-07-02: Delegation floor met via Forge (code generation of logCache.ts/server.ts refactor) and Explore (call-site verification across server.ts).
