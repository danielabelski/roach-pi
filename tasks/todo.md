# Current: Fix scroll-up hijack from welcome banner shimmer

Problem: 대화가 한 화면을 넘으면 위로 스크롤이 불가능 — 즉시 맨 아래로 스냅됨.

Root cause (confirmed via PI_DEBUG_REDRAW=1):
- welcome 배너 shimmer가 33ms마다 뷰포트 *위*의 배너 줄을 변경
- pi-tui 차분 렌더러는 뷰포트 위 변경을 부분 갱신 못 해 `fullRender(true)`로 후퇴 (`firstChanged < viewportTop`)
- `fullRender(true)`는 `\x1b[2J\x1b[H\x1b[3J`로 스크롤백까지 삭제 → 초당 ~29회 스크롤백 파괴
- 격리 검증: `/welcome off` → fullRender 29/s → 0/s

Done when:
- [x] Failing test: 대화 시작 후 shimmer가 멈추고 정적 배너로 렌더된다.
- [x] Fix: `freezeWelcomeShimmer()` — before_agent_start 및 기존 대화가 있는 세션 복원 시 shimmer 정지.
- [x] Unit tests pass (welcome-ui.test.ts + full suite).
- [x] E2E re-verify: PI_DEBUG_REDRAW=1로 재실행, 에이전트 작업 중 fullRender 스톰이 사라짐.

## Review

Completed. 3중 방어로 수정:
- `welcome-ui.ts`: ① tick 자가-감지 — `tui.previousLines.length > tui.terminal.rows`(배너가 뷰포트 위)면 영구 freeze. 내부 필드는 optional 접근으로 감싸 버전 변화 시 무해하게 무시. ② `freezeWelcomeShimmer()`/`unfreezeWelcomeShimmer()` 모듈 API 추가.
- `index.ts`: ③ `before_agent_start`에서 freeze(대화 시작), `session_start`에서 대화 엔트리(message/custom_message/compaction/branch_summary) 존재 시 freeze — fresh 세션의 북키핑 엔트리(session/custom)는 무시하고 애니메이션 허용.
- `tests/welcome-ui.test.ts`: freeze 후 정적/시간불변 렌더, frozen 상태 신규 헤더 정적, 뷰포트 초과 시 자가-freeze, 뷰포트 내 애니메이션 유지 — 4개 테스트 추가.

검증:
- 유닛: welcome-ui 9/9, 전체 스위트 74 파일 / 821 테스트 PASS, `tsc --noEmit` PASS.
- E2E (tmux + `PI_DEBUG_REDRAW=1`): 수정 전 fullRender 스톰 **~29회/초**(수천 건, 전부 `firstChanged < viewportTop`) → 수정 후 **세션 전체에 2건**(최초 렌더 + 시작 덤프 성장 1회). `/welcome off` 격리 실험으로 원인 단일성 검증(off 시 0회).
- 큰 화면(85행, 배너가 뷰포트 안): shimmer 애니메이션 유지 확인.

Root cause 기록: welcome 배너 shimmer(33ms tick)가 뷰포트 *위* 줄을 변경 → pi-tui 차분 렌더러가 `fullRender(true)`로 후퇴 → `\x1b[2J\x1b[H\x1b[3J`가 터미널 스크롤백을 매 프레임 삭제 → 위로 스크롤 불가. 상류(pi-tui)의 근본 이슈는 fullRender의 `\x1b[3J` 스크롤백 삭제 — 필요 시 업스트림 이슈 제기 가치 있음.

---

# Current: Subagent render ellipsis fix

Done when:
- [x] Partial single-mode subagent calls no longer render `subagent ...`.
- [x] Completed invalid args render explicit missing labels.
- [x] Collapsed completed results include task preview.
- [x] Collapsed running results prefer `lastActivity` preview.
- [x] Focused tests, TypeScript build, and full test suite pass.

Plan:
- [x] Write executable plan at `docs/engineering-discipline/plans/2026-05-11-subagent-render-ellipsis-fix.md`.
- [x] Execute Task 1: partial args call rendering.
- [x] Execute Task 2: collapsed result task/activity preview.
- [x] Execute Task 3: final verification and regression review.

## Review

Completed.
- `extensions/agentic-harness/render.ts`: added `RenderCallContext`, one-line `previewText`, explicit `starting...` / `receiving task...` / missing-label rendering, and collapsed single-result preview logic preferring `lastActivity` over task.
- `extensions/agentic-harness/index.ts`: forwards Pi render context to the subagent renderer.
- `extensions/agentic-harness/tests/render.test.ts`: added focused coverage for incomplete args, valid args, missing completed args, collapsed task preview, lastActivity priority, and truncation.
- Plan note: corrected the truncation test marker from `end` to `TAIL_MARKER` because `rendering` contains substring `end`.
- Verification: `cd extensions/agentic-harness && npm test -- tests/render.test.ts` — PASS, 25 tests.
- Verification: `cd extensions/agentic-harness && npm run build` — PASS.
- Verification: `cd extensions/agentic-harness && npm test` — PASS, 61 files / 743 tests.

---

# Current: Fix zombie async-run inheritance across pi sessions

---

# Current: Strip codex "<!-- -->" thinking placeholders at render time

Done when:
- [x] Root cause confirmed with evidence (session JSONL shows OpenAI Codex sends `**Header**\n\n<!-- -->` reasoning-summary parts; pi/pi-ai never generate the string).
- [x] Failing guard exists before the fix (component-level test renders literal `<!-- -->`).
- [x] Display-only fix: stored session data and provider round-trip payload stay untouched.
- [x] Guard passes; no regressions in the extension test suite.

## Review

- Root cause: OpenAI Codex reasoning summaries use empty HTML comments as withheld-body placeholders; invisible in HTML UIs but pi's terminal Markdown renderer prints them literally (`assistant-message.js` renders `content.thinking` verbatim).
- `extensions/agentic-harness/thinking-placeholder-filter.ts`: `stripThinkingPlaceholders` (removes `<!--\s*-->`, collapses leftover blank lines) + `installThinkingPlaceholderFilter` (idempotent prototype wrap of `AssistantMessageComponent.updateContent`; sanitizes a display copy only, no-ops safely if core shape changes).
- `extensions/agentic-harness/index.ts`: installs the filter at extension entry.
- `extensions/agentic-harness/tests/thinking-placeholder.test.ts`: characterizes unpatched output (contains `<!-- -->`), asserts patched output drops placeholders but keeps headers, stored message unmutated, install idempotent, non-empty HTML comments preserved.
- Verification: `bun test extensions/agentic-harness/tests/thinking-placeholder.test.ts` — PASS, 6 tests.
- Verification: full suite failure list identical before/after (59 pre-existing bun/vitest-compat failures, zero new).
