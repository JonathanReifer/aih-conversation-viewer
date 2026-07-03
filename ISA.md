---
project: aih-conversation-viewer
effort: E3
phase: verify
progress: 39/39
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

## Phase 2 — timestamps, iterable category navigation, Security-page jump fix

- [x] ISC-31: `ProxySessionIndex.entryTimestamps: {ts, tokenizedLength}[]` populated in `segmentProxySessions` from the already-sorted group, zero new I/O
- [x] ISC-32: `deriveMessageTimestamps(entryTimestamps, messageCount, lastTs)` pure function — single forward two-pointer walk, exported and unit-tested (3 cases: mid-walk labeling, fallback-to-lastTs when count exceeds every snapshot, empty-entryTimestamps fallback)
- [x] ISC-33: `ProxySessionFinding = ProxyLogFinding & {fromMessageIndex, toMessageIndex, ts}` — range attribution via a running `prevLength` cursor over `sorted` entries in `segmentProxySessions`'s finding aggregation
- [x] ISC-34: `proxyLog.test.ts` additive assertions pass — `findings[0].fromMessageIndex/toMessageIndex/ts` on the multi-entry fixture, `entryTimestamps` shape/order on single-entry/multi-entry/gap-split fixtures
- [x] ISC-35: `handleSession` API response (both proxy-only and unified branches) carries `messageTimestamps: string[]`, index-aligned with `messages`, computed via `deriveMessageTimestamps` right after hydration
- [x] ISC-36: client renders per-message timestamps — `renderProxyMessage` threads `messageTimestamps[i]` through `fmtTime()`, proxy-context tool cards pass the containing message's real ts instead of hardcoded `null`
- [x] ISC-37: generalized `categoryHits`/`categoryIdx`/`activeCategory` registry covering `pii`/`tools`/`secrets`/`findings` — `populateCategoryHits()`, `selectCategory(cat)` (jump-to-first + nav bar per assumption #2), `advanceCategory(dir)` (wraparound + `.cat-active` + `scrollIntoView`), `#cat-nav-bar` UI; `data-cat`/`data-ts` markup wired into `renderToolCard`/`renderPairedCard`/finding markers; header badges (`tools`/`secrets`/`findings`/`pii`) all wired to `onclick="selectCategory(...)"`; `nextPii()` reduced to a 1-line back-compat wrapper
- [x] ISC-38: Security-page jump fix — `handleSession`'s unified-branch lookup broadened from `u.id === id` to `u.id === id || u.otelId === id || u.proxyId === id` (fixes the id-format mismatch that silently 404'd exactly the sessions richest in findings); `switchToSession(id, target)`/`loadSession(id, target)` thread an optional `{cat, ts}` target through to a new `jumpToTarget(target)` (nearest-`data-ts` match within `categoryHits[target.cat]`, mirroring the existing OTEL/proxy cost-badge nearest-time-bucket idiom); both Security-page row click handlers (`renderEventsTable` → `{cat:'findings', ts:ev.ts}`, `renderSecretsBreakdown` → `{cat:'secrets', ts:ev.ts}`) updated accordingly
- [x] ISC-39: Anti/safety-net — isolated-copy spot-check (rsynced repo, patched `PORT`, synthetic fixture + mock-Loki, `curl` the served page, extract `<script>`, `node --check`) caught a real pre-existing bug: a `//` comment inside `jumpToTarget`'s own doc-comment (server.ts ~1902) contained literal backticks (`` `target.ts` ``/`` `target.cat` ``), which prematurely closed the *outer* server-side template literal the whole client `<script>` lives inside — same failure class as the earlier `\'`/`\\'` escaping incident, undetectable by `bun test` alone since server.ts's top-level `Bun.serve()` call means it's never imported by any test file. Fixed by rewriting the comment without backticks; re-ran the isolated instance — `node --check` clean; confirmed no other stray backticks inside the embedded-script line range (1039-2138) via `awk`; `bun test` 29/29 on the real repo post-fix; isolated instance + mock-Loki torn down, scratch copies removed, real production instance (PID 4044370, port 4446) confirmed untouched throughout (`ps -p`, `curl` HTTP:200)

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
| ISC-31..34 | unit | bun test suite (proxyLog.test.ts additive) | all pass | Bash `bun test` |
| ISC-35 | code | handleSession response shape | messageTimestamps present, index-aligned | Read + curl |
| ISC-36..38 | manual + devops2 | client rendering, category nav, security-page jump | timestamps render, nav bar steps correctly, row click lands on right message | Interceptor (devops2) |
| ISC-39 | syntax | isolated-instance `node --check` on served `<script>` | clean, 0 errors | Bash + node --check |

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
- 2026-07-02: "Secrets" defined as a filtered slice of `findings` (by `scannerId`), not an alias for the PII regex-scan — kept as a separate category in the nav registry rather than merged with `pii`.
- 2026-07-02: Badge click jumps to the first instance and shows a floating nav bar ("N of M" + ‹ ›), not cycle-in-place — scales better once a category has many instances.
- 2026-07-02: Per-message timestamps are approximate ("became visible no later than this snapshot's ts"), not exact wall-clock — a raw proxy-log entry snapshots the whole conversation at once, so exact per-message timing isn't recoverable.
- 2026-07-02: Findings attributed to a message range (`fromMessageIndex`/`toMessageIndex`) rather than a single index, since one log entry can add more than one message since the prior snapshot.
- 2026-07-02: Isolated-copy syntax spot-check (rsync + patched PORT + synthetic fixture, `node --check` on the extracted served script) kept as a standing pre-push safety net alongside — never instead of — real Interceptor browser verification, per this project's established incident history.
