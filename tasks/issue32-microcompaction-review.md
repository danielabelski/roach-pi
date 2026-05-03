# Issue #32 Microcompaction Fix Review

**Date:** 2026-05-03
**Scope:** Review uncommitted fix for prompt-cache instability caused by agentic-harness microcompaction.
**Verdict:** PASS

## Review Criteria
- Microcompaction disabled by default.
- Users can opt in with `PI_AGENTIC_MICROCOMPACTION=1`.
- Opt-in compact marker is deterministic across repeated calls.
- Opt-in env flag propagates to tmux-backed workers.
- Tests/build pass.
- No obvious prompt-cache regressions remain for default usage.

## Findings

### 1. Default behavior no longer rewrites context — PASS
`extensions/agentic-harness/index.ts` now returns early from the `context` handler unless `PI_AGENTIC_MICROCOMPACTION === "1"`.

Impact: default users no longer have provider payloads rewritten before every LLM call, preserving prompt/KV cache behavior for the reported issue.

### 2. Marker no longer changes every minute — PASS
`extensions/agentic-harness/compaction.ts` now emits `[Compacted] ${toolName} result` instead of including elapsed minutes.

Impact: once a tool result is compacted, repeated calls no longer change the marker solely because wall-clock time advanced.

### 3. Opt-in propagates to tmux-backed workers — PASS
`extensions/agentic-harness/subagent.ts` now includes `PI_AGENTIC_MICROCOMPACTION` in the `buildTmuxLaunchEnv()` allowlist.

Impact: users who opt in at the root process get consistent behavior in tmux-backed workers instead of silently losing the flag.

### 4. Opt-in microcompaction still has an age-threshold cache boundary — Residual / Acceptable for opt-in
Even with stable markers, age-based compaction means a prompt can still change when a historical tool result first crosses the 60-minute threshold.

Impact: this can invalidate cache once at the crossing point. Because the feature is now opt-in, this is acceptable for the immediate fix, but it should be documented if microcompaction remains available.

Possible future improvement: explicit/manual tool-result compaction, persisted compaction decisions, or non-time-based deterministic selection.

### 5. Test coverage — PASS
Added tests cover:
- default-disabled context behavior,
- opt-in context behavior,
- stable compact marker behavior,
- tmux env propagation for `PI_AGENTIC_MICROCOMPACTION`.

## Verification Commands

```bash
cd extensions/agentic-harness && npx vitest run tests/subagent.test.ts tests/compaction.test.ts tests/extension.test.ts
cd extensions/agentic-harness && npm run build
cd extensions/agentic-harness && npm test
```

Result: PASS — 40 test files, 445 tests passed.

LSP diagnostics: PASS — 0 TypeScript errors reported for `extensions/agentic-harness`.

`git diff --check`: PASS.

## Overall Assessment
The main issue report is fixed for the default path: loading the extension will no longer silently rewrite request context or defeat prompt/KV caching. The deterministic marker removes the worst repeated-cache-invalidation behavior when users explicitly enable microcompaction. The opt-in flag now also propagates to tmux-backed workers.
