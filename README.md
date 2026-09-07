# pi-agent Memory-Anchored Compact

[English](README.md) | [简体中文](README.zh.md)

A custom context-compaction extension for the installed **pi CLI**
(`@earendil-works/pi-coding-agent` ≥ 0.85), implementing exactly this algorithm:

1. **Keep the first N messages** — the opening messages (task/constraints) stay verbatim;
2. **Retrieve memories related to the first N messages, keep N of them** — memories are
   retrieved from pi's own session history/tree (AGENTS.md family, historical sessions,
   existing compaction/branch summaries) and injected;
3. **Keep the system prompt fixed** — it is never touched;
4. **Fold everything else into a summary** — complete turns after the head are collapsed
   into one structured summary.

Unlike pi's native compaction (which keeps the *recent* tail via `keepRecentTokens` and
summarizes the *old* head), this mechanism **keeps the head and folds the tail**, and injects
memories relevant to the opening task between the head and the summary — so the task
definition and key constraints never get lost in long sessions.

Design document: [`DESIGN.md`](./DESIGN.md).

## Implementation: Route A (pure extension, no pi core changes)

- Registers `/memory-compact [N]` and `/memory-compact reset` commands plus automatic triggering;
- The `context` event rewrites the request view before every model call to
  `system + opening N (verbatim) + memory block + summary block + latest turns`;
- Session JSONL and pi internals are left untouched, so pi upgrades keep working and the
  full `/tree` history is preserved.

All core logic lives in `src/plan.ts` / `src/compact.ts` / `src/memory.ts` /
`src/sources.ts` etc. — **no pi runtime dependency**, unit-testable with `node --test`.
`src/extension.ts` is a thin pi adapter.

## Install / Enable

### 1. Disable pi's native auto-compaction (avoid two compactors fighting)

Add to `~/.pi/agent/settings.json` or the project `.pi/settings.json`:

```json
{
  "compaction": { "enabled": false },
  "extensions": ["/Users/raphaelwu/AI/pi-agent-compact/src/extension.ts"]
}
```

> Once the extension is loaded, run `/memory-compact` manually or let automatic triggering
> fire when context pressure gets high. pi's native `/compact` still works but uses the
> official "keep-recent" semantics; prefer `/memory-compact` with this mechanism.

### 2. Optional configuration

Project-level: `.pi/memory-compact.json`; global: `~/.pi/agent/memory-compact.json`.
Environment variables `PI_MEMORY_COMPACT_*` override any of these.

```json
{
  "enabled": true,
  "headMessages": 5,
  "memoryItems": 5,
  "triggerRatio": 0.75,
  "useAgentsMd": true,
  "useSiblingSessions": true,
  "bm25K1": 1.5,
  "bm25B": 0.75,
  "maxMemoryItemChars": 1200
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `headMessages` | `5` | Number of leading messages kept verbatim (auto-extended to a full turn; never splits paired tool messages) |
| `memoryItems` | `5` | Number of memory items injected |
| `triggerRatio` | `0.75` | Auto-fold when context usage exceeds this fraction of the window (and only when ≥ 2048 new tokens accrued) |
| `useAgentsMd` | `true` | Memory source: AGENTS.md / CLAUDE.md / AGENTS.override.md (cwd upward + agentDir) |
| `useSiblingSessions` | `true` | Memory source: same-project historical session JSONLs (compaction/branch summaries + first user message) |
| `bm25K1` / `bm25B` | `1.5` / `0.75` | BM25 parameters |
| `maxMemoryItemChars` | `1200` | Max chars per injected memory item |

### 3. Usage

```
/memory-compact          # manual trigger (runs at the next request), current config
/memory-compact 10       # manual trigger, N=10 for this run
/memory-compact reset    # clear the current session's compact checkpoint
```

Automatic triggering: when the estimated context exceeds
`triggerRatio × contextWindow` and enough new complete turns exist after the head,
one fold runs inside the `context` event; it never re-folds within the same round.

## Memory sources (how step 2 is implemented)

Query = user text of the opening N messages. Candidate memories come from:

- `AGENTS.md` / `CLAUDE.md` / `AGENTS.override.md`: from cwd up to agentDir, plus agentDir itself;
- Other sessions under the same-project session dir
  `~/.pi/agent/sessions/--<cwd>--/*.jsonl`: their `compaction` summaries,
  `branch_summary` summaries and first user messages (current session file excluded);
- Scoring: lightweight **BM25** without embeddings (CJK 2-grams + latin words) plus
  **time decay** (~14-day half-life), Top-N injected, over-long items truncated.

## Safety boundaries

- Folding only happens at **complete turn boundaries**; an assistant `toolCall` is never
  separated from its `toolResult`;
- The still-running "current turn" always stays verbatim (so tool loops are not disturbed);
  manual `/memory-compact` uses `fold-all`: everything folds except an unanswered user prompt;
- The system prompt is never modified;
- Session files are read-only, nothing is deleted (rewrites only affect the request view);
- An empty summary or a failed model call abandons that fold — it never affects the user request.

## Tests

```sh
node --test "test/*.test.ts"
```

Coverage: head boundary selection (incl. tool pairing and degenerate sessions), fold
boundaries (both policies), trigger thresholds, BM25 with mixed CJK/English scoring,
session JSONL memory extraction, summary prompt construction, layout slicing and
injection formatting.

## Files

```
src/types.ts          Pure types and defaults
src/serialize.ts      Message serialization / turn-start detection
src/plan.ts           Head boundary + fold boundary + trigger decision (pure)
src/memory.ts         Tokenization + BM25 ranking + truncation (pure)
src/sources.ts        Session JSONL / AGENTS.md memory extraction (pure)
src/compact.ts        Checkpoint → view slicing / injected block assembly (pure)
src/prompts.ts        Structured summary prompt (pi-native format)
src/settings.ts       Config parsing (pure)
src/retrieve-query.ts Memory query text (pure)
src/extension.ts      pi extension adapter (events, commands, file I/O, model calls)
test/*.test.ts        Unit tests
DESIGN.md             Design document
```
