# Workspace Memory Prompt Cap — Completed

## Goal
Cap workspace-memory system prompt injection size so recalled memories cannot bloat every LLM turn.

## Planning Checklist
- [x] Inspect workspace-memory recall/injection implementation.
- [x] Inspect existing tests and verification commands.
- [x] Write executable plan under `docs/engineering-discipline/plans/`.
- [x] Self-review plan for exact files, commands, dependencies, and verification.
- [x] Present plan path and receive approval for subagent execution.

## Execution
- [x] Task 1 implemented and validated: bounded formatter in `extensions/workspace-memory/recall.ts`.
- [x] Task 2 implemented and validated: focused recall formatting tests in `extensions/workspace-memory/tests/recall.test.ts`.
- [x] Task 3 implemented and validated: integration prompt cap assertion in `extensions/workspace-memory/tests/integration.test.ts`.
- [x] Task 4 final verification passed.

## Output
- Plan saved: `docs/engineering-discipline/plans/2026-05-03-workspace-memory-prompt-cap.md`
- Commits:
  - `586e1db fix(memory): cap recalled prompt context size`
  - `57ec7be test(memory): cover recalled prompt size caps`
  - `56d7dae test(memory): verify bounded system prompt injection`

## Verification
- [x] `npm --prefix extensions/workspace-memory test && npm --prefix extensions/workspace-memory run build` — 5 files / 11 tests passed; TypeScript build passed.
- [x] `git diff --stat HEAD~3..HEAD -- extensions/workspace-memory/recall.ts extensions/workspace-memory/tests/recall.test.ts extensions/workspace-memory/tests/integration.test.ts` — scoped to workspace-memory prompt cap implementation/tests.

## Review
- Added `MAX_RECALL_CONTEXT_CHARS = 8000` and `MAX_RECALL_MEMORY_CHARS = 2000`.
- Added explicit truncation and omission markers for prompt-budget enforcement.
- Preserved recall selection/ranking and `recalledIds` semantics; only formatted injected text is bounded.
- Verified caller behavior in `workspace-memory/index.ts` needs no change.


---

# WebSocket Error Debugging — In Progress

## Problem
- User reports frequent `WebSocket error` after tool output; example shown after writing `docs/engineering-discipline/harness/powerline-ui/checkpoints/M5-checkpoint.md`.

## Debugging Plan
- [x] Attempt reproduction first with the referenced checkpoint-sized markdown write.
- [ ] Gather observable evidence from Pi logs / reproduction commands.
- [ ] Form one root-cause hypothesis from evidence.
- [ ] Add a failing guard or deterministic reproduction check before changing code.
- [ ] Apply one targeted fix.
- [ ] Verify original reproduction path and related tests.

## Reproduction Notes
- Initial local tool-write reproduction to `/tmp/pi-websocket-repro-M5-checkpoint.md` wrote 1777 bytes successfully; no `WebSocket error` appeared in this harness response.

---

# Powerline UI Long Run — M1 Completed

## Status
- [x] Milestone plan approved and artifacts saved under `docs/engineering-discipline/harness/powerline-ui/`.
- [x] M1 plan saved: `docs/engineering-discipline/plans/2026-05-03-footer-status-bridge-powerline-mvp.md`.
- [x] M1 implemented: footer status bridge + width-safe Powerline MVP.
- [x] M1 review passed: `docs/engineering-discipline/reviews/2026-05-03-footer-status-bridge-powerline-mvp-review.md`.
- [x] M1 checkpoint written: `docs/engineering-discipline/harness/powerline-ui/checkpoints/M1-checkpoint.md`.

## Verification
- [x] `npm --prefix extensions/agentic-harness test -- --run tests/footer.test.ts tests/plan-progress.test.ts tests/milestone-tracker.test.ts tests/extension.test.ts` — 125 passed.
- [x] `npm --prefix extensions/agentic-harness test && npm --prefix extensions/agentic-harness run build` — 541 passed; build passed.
- [x] `git diff -- extensions/agentic-harness/package.json extensions/agentic-harness/package-lock.json extensions/fff-search/index.ts` — no diff.
- [x] M2 verification: `npm --prefix extensions/agentic-harness test && npm --prefix extensions/agentic-harness run build` — 552 passed; build passed.

## Next
- [x] All milestones (M1–M6 + M_final) completed.
- [ ] Powerline UI long run is DONE.

---

# README Feature Story Revamp

## Context
The user wanted the root `README.md` rewritten in the spirit of `can1357/oh-my-pi`: a stronger public-facing, English README that explains the extension suite's capabilities clearly, including installation and usage. They chose a full README revamp and asked to reserve space for new hero/screenshot assets.

## Plan
- [x] Audit existing feature surface from `README.md`, extension READMEs, package metadata, and command/tool registrations.
- [x] Draft a public-facing README structure: hero, badges, highlights, getting started, usage, commands, tools, extensions, configuration, development, testing, contributing, license.
- [x] Create lightweight visual asset placeholders under `assets/` for the hero and screenshots so README links are valid.
- [x] Rewrite root `README.md` in English with clear feature explanations and accurate installation/setup instructions.
- [x] Verify markdown links/asset paths and review the final README for accuracy against the codebase.

## Scope
- In scope: root `README.md`, new `assets/` placeholder visuals.
- Out of scope: changing runtime behavior, publishing package metadata, generating real terminal screenshots.

## Verification
- [x] Manual docs review against source files and existing docs.
- [x] Confirmed referenced local paths exist.
- [x] Parsed all new SVG assets as valid XML.
- [x] Spot-checked documented commands/tools against local source and bundled package docs.
- [x] Ran `git diff --check -- README.md assets/hero.svg assets/workflow-preview.svg assets/review-search-preview.svg tasks/todo.md`.

## Review
- Rewrote `README.md` into a public-facing landing page with hero, badges, highlights, installation, first-use workflow, feature tour, command/tool reference, configuration, repository layout, and development instructions.
- Added lightweight SVG visuals:
  - `assets/hero.svg`
  - `assets/workflow-preview.svg`
  - `assets/review-search-preview.svg`
- Kept claims grounded in current source: no root `npm test` claim, no nonexistent `LICENSE` link, and no autonomous-dev GitHub tool claims.

---

# Previous Note: Milestone Planning Visibility Improvement

## Context
A live footer screenshot showed `0/6 ○M1...` while a new long-run was beginning. This was initially treated as a bug, but the user clarified the existing behavior was working; the workflow was still in planning, so it was not necessarily a completion/tracking failure.

## Decision
Keep the latest change as a visibility improvement: when a subagent explicitly references a harness milestone file, the footer can show the milestone phase earlier.

## Implemented
- `extractMilestonePathsFromArgs()` detects explicit `docs/engineering-discipline/harness/.../milestones/M1-*.md` references in subagent args.
- `startMilestonesFromSubagentArgs()` promotes referenced milestones:
  - explorer/planner/etc. → `planning`
  - plan-worker/plan-compliance → `executing`
  - plan-validator → `validating`
- Planning promotion only marks the first non-terminal referenced milestone, avoiding artifact-list false positives.

## Verification
- Focused tests: 89 passed
- Full suite: 53 files, 640 tests passed

## Note
This is intentionally retained as UX improvement, not because the prior behavior was proven broken.
