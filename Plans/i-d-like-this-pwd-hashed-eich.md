# Plan: Tool Call Display — OTEL Fix, Call/Result Linking, Better Formatting

## Context

Three improvements to `src/server.ts` (all changes in the embedded `<script>` and `buildOtelTimeline` function):

1. **OTEL view doesn't show tool calls** — `buildOtelTimeline()` processes both `claude_code.tool_decision` AND `claude_code.tool_result`, creating duplicate (often empty) cards. Only `tool_result` carries the useful fields (`tool_input`, `tool_result_size_bytes`, `success`, `decision_type`, `duration_ms`). Tool_decision should be skipped entirely.

2. **Tool calls and results are unlinked** — In proxy/unified view, `tool_use` blocks and `tool_result` blocks render as independent cards. The proxy data links them via `tool_use.id` ↔ `tool_result.tool_use_id`. They should render as one paired card: call on top, result nested below.

3. **Expanded tool body is raw JSON** — The `.tool-body` just dumps `JSON.stringify(input, null, 2)`. Should show tool-specific formatted sections (input fields labeled, result content readable).

---

## Fix 1 — OTEL `buildOtelTimeline()` (`src/server.ts` ~line 248)

Every tool invocation must be visible — approved, blocked, automatic, or rejected. The `tool_decision` event fires for all of them. The `tool_result` event fires only when the tool actually executed (i.e., was accepted). 

**Strategy: `tool_decision` is the primary card; `tool_result` is merged in when available.**

```typescript
// Two-pass approach in buildOtelTimeline():

// Pass 1: index all tool_result events by tool_use_id
const resultByToolUseId = new Map<string, LokiEntry>();
for (const e of sorted) {
  if (e.body === "claude_code.tool_result") {
    resultByToolUseId.set(String(e.attributes["tool_use_id"] ?? ""), e);
  }
}

// Pass 2: emit one tool event per tool_decision, merging result data when available
for (const e of sorted) {
  if (e.body === "claude_code.tool_decision") {
    const toolUseId = String(e.attributes["tool_use_id"] ?? "");
    const result = resultByToolUseId.get(toolUseId);  // may be undefined (blocked/rejected)
    let inputParsed: unknown = result
      ? result.attributes["tool_input"]          // result has the parsed input
      : e.attributes["tool_parameters"];         // decision has params as fallback
    try { inputParsed = JSON.parse(String(inputParsed)); } catch { /* keep string */ }
    timeline.push({
      kind: "tool",
      ts: e.ts,
      toolName: String(e.attributes["tool_name"] ?? "tool"),
      toolUseId,
      decision: String(e.attributes["decision"] ?? "accept"),  // approve/block/reject
      input: inputParsed,
      // from result if it ran:
      resultSizeBytes: result ? Number(result.attributes["tool_result_size_bytes"] ?? 0) : 0,
      success: result ? String(result.attributes["success"]) === "true" : false,
      durationMs: result ? Number(result.attributes["duration_ms"] ?? 0) : 0,
      executed: !!result,
    });
  }
  // tool_result is consumed via the map above — not emitted separately
}
```

This produces **one card per tool invocation** showing:
- Decision badge: `✅ auto` / `👤 approved` / `🚫 blocked` / `❌ rejected` (from `decision` field + source)
- If executed: result size, duration — otherwise no result metadata
- Visual difference: unexecuted tools get a greyed-out/strikethrough style

Update `OtelTimelineEvent` tool kind to include `toolUseId`, `decision`, `durationMs`, `executed` fields.

---

## Fix 2 — Paired tool call/result cards (proxy + unified view)

**Where:** `renderContent()` in the embedded JS (~line 689).

**Current behaviour:** Each `tool_use` and `tool_result` block in a message's content array is mapped independently to a card. Results appear orphaned below calls with no visual connection.

**New approach:** Pre-process the content array before mapping to pair each `tool_result` with its `tool_use` by `tool_use_id`:

```javascript
function renderContent(content) {
  if (typeof content === 'string') return esc(content);
  if (!Array.isArray(content)) return esc(JSON.stringify(content));

  // Build a lookup of tool_use blocks by id
  const toolUseById = {};
  for (const block of content) {
    if (block?.type === 'tool_use' && block.id) toolUseById[block.id] = block;
  }

  // Track which tool_use ids have been consumed by a paired result
  const consumed = new Set();

  return content.map(block => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text') { ... }                    // unchanged
    if (block.type === 'tool_use') {
      if (consumed.has(block.id)) return '';              // already rendered as part of a pair
      return renderToolCard(block.name||'tool', block.input, null, true, 'accept', null, null);
    }
    if (block.type === 'tool_result') {
      const call = toolUseById[block.tool_use_id];
      consumed.add(block.tool_use_id);
      return renderPairedCard(call, block);              // new function
    }
    return '';
  }).filter(Boolean).join('');
}
```

**`renderPairedCard(callBlock, resultBlock)`** — renders a single combined card:
- Header shows tool name + input preview (same as current)
- Expanded body has two labeled sections: **Input** and **Result** (see Fix 3 for formatting)
- Footer: `is_error` flag, result content length

If a `tool_result` arrives with no matching `tool_use` (shouldn't happen but defensive): render result alone with `result` as the tool name.

---

## Fix 3 — Tool-specific formatted body

**Where:** Replace the current `renderToolCard` body section and introduce `renderToolBody(toolName, input, resultText)`.

The `.tool-body` div currently dumps raw JSON. Replace with **labeled sections** using a small helper:

```javascript
function renderToolBody(toolName, input, resultText) {
  const sections = [];
  const i = input || {};

  if (toolName === 'Bash' || toolName === 'bash') {
    sections.push(['Command', i.command || '']);
    if (i.description) sections.push(['Description', i.description]);
  } else if (toolName === 'Read') {
    sections.push(['File', i.file_path || '']);
    if (i.offset) sections.push(['Offset', String(i.offset)]);
    if (i.limit) sections.push(['Limit', String(i.limit)]);
  } else if (toolName === 'Write') {
    sections.push(['File', i.file_path || '']);
    if (i.content) sections.push(['Content', i.content]);
  } else if (toolName === 'Edit' || toolName === 'MultiEdit') {
    sections.push(['File', i.file_path || '']);
    if (i.old_string) sections.push(['Find', i.old_string]);
    if (i.new_string) sections.push(['Replace', i.new_string]);
  } else if (toolName === 'Agent') {
    if (i.description) sections.push(['Description', i.description]);
    if (i.prompt) sections.push(['Prompt', i.prompt]);
  } else if (toolName === 'WebFetch') {
    sections.push(['URL', i.url || '']);
    if (i.prompt) sections.push(['Prompt', i.prompt]);
  } else if (toolName === 'WebSearch') {
    sections.push(['Query', i.query || '']);
  } else if (toolName === 'Grep' || toolName === 'Glob') {
    sections.push(['Pattern', i.pattern || i.query || '']);
    if (i.path) sections.push(['Path', i.path]);
  } else {
    // Generic: render each top-level key as a labeled field
    for (const [k, v] of Object.entries(i)) {
      sections.push([k, typeof v === 'string' ? v : JSON.stringify(v, null, 2)]);
    }
  }

  if (resultText) sections.push(['Result', resultText]);

  return sections.map(([label, val]) =>
    '<div class="tb-section">'+
    '<div class="tb-label">'+esc(label)+'</div>'+
    '<pre class="tb-value">'+esc(val)+'</pre>'+
    '</div>'
  ).join('');
}
```

**New CSS** for the labeled sections (add to existing `<style>`):
```css
.tb-section { margin-bottom: 8px; }
.tb-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
            color: #4a5568; margin-bottom: 3px; }
.tb-value { margin: 0; font-size: 11px; font-family: monospace; color: #94a3b8;
            white-space: pre-wrap; word-break: break-all; background: #0f0f1a;
            border: 1px solid #1e1e30; border-radius: 4px; padding: 6px 8px;
            max-height: 200px; overflow-y: auto; }
```

Update `renderToolCard` to call `renderToolBody(toolName, input, null)` for OTEL/unpaired, and `renderPairedCard` to call `renderToolBody(toolName, input, resultText)` with the result content.

---

## Files Modified

| File | Section | Change |
|------|---------|--------|
| `src/server.ts` | `buildOtelTimeline()` ~L248 | Drop `tool_decision` from branch condition; add `durationMs` extraction |
| `src/server.ts` | `OtelTimelineEvent` type ~L53 | Add `durationMs` to tool kind |
| `src/server.ts` | embedded `<style>` | Add `.tb-section`, `.tb-label`, `.tb-value` CSS |
| `src/server.ts` | embedded `<script>` | Add `renderPairedCard()`, `renderToolBody()`; update `renderContent()` pairing logic; update `renderToolCard()` to call `renderToolBody` |

---

## Verification

1. `bun src/server.ts` starts cleanly, `node --check` on extracted JS passes
2. OTEL view: click a session — tool cards appear (one per tool call, not doubled)
3. Proxy/unified view: tool call + result render as one paired card; call input and result output are both visible in the expanded body
4. Expanded body: labeled sections (`Command`, `File`, `Result`, etc.) instead of raw JSON blob
5. Multiple back-to-back tool calls each have their result correctly paired (not cross-linked)
