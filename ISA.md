---
project: aih-conversation-viewer
effort: E3
phase: build
progress: 0/18
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

- [ ] ISC-1: `src/logCache.ts` exists and exports `createJsonlTailCache<T>()`
- [ ] ISC-2: `bun test` suite covers cold read of N valid lines
- [ ] ISC-3: `bun test` suite covers malformed JSON line skipped without breaking subsequent lines
- [ ] ISC-4: `bun test` suite covers incremental append — previously-returned entries are reference-identical (`===`) across calls
- [ ] ISC-5: `bun test` suite covers partial trailing line invisible until completed
- [ ] ISC-6: `bun test` suite covers copy-truncate rotation (`size < byteOffset`) detected and reset
- [ ] ISC-7: `bun test` suite covers inode-change rotation detected and reset
- [ ] ISC-8: `bun test` suite covers missing-file-at-cold-start returns `[]` without throwing
- [ ] ISC-9: `bun test` suite covers transient-missing-after-data returns last-known-good
- [ ] ISC-10: `readAuditEntries(startTs, endTs)` date-filter still narrows correctly on top of the shared cache
- [ ] ISC-11: `server.ts`'s `readProxyEntries()`/`readAuditEntries()` are thin wrappers around `createJsonlTailCache` instances with unchanged signatures
- [ ] ISC-12: pre-warm call (both caches) executes before `Bun.serve()` and logs entry counts + elapsed ms
- [ ] ISC-13: `package.json` has `"test": "bun test"` script
- [ ] ISC-14: `bun test` passes locally on devops1 pre-deploy
- [ ] ISC-15: golden-diff on devops2 — old vs. new code against identical synthetic fixture returns byte-identical JSON across all 4 endpoints
- [ ] ISC-16: live-append-while-running test on devops2 — new fixture lines appear via `/api/sessions` without a server restart
- [ ] ISC-17: RSS-loop test on devops2 — RSS plateaus (not grows) across 20-30 requests after warm-up
- [ ] ISC-18: Anti: devops1's real `prompts.jsonl` is never copied to or read from devops2 during testing
- [ ] ISC-19: devops1 post-redeploy — pre-warm log line reports sane entry count against the real 2.8GB file, RSS stays flat across repeated requests, `sudo dmesg -T` shows no new OOM kill of the conv-viewer process

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
