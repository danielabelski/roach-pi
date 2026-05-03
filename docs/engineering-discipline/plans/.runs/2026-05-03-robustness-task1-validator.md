# Validation: Task 1 — Add PlanProgressTracker snapshot and recovery methods

**Verdict:** PASS

## Acceptance Criteria

- **`getTaskStatuses()` method exists**: PASS — Implemented at `plan-progress.ts:230`. Returns `Array<{ id: number; status: TaskStatus }>` by mapping `this.tasks`. Matches plan spec exactly.

- **`restoreTaskStatuses()` method exists**: PASS — Implemented at `plan-progress.ts:234`. Guards with `hasPlan()`, builds a `Map` from input statuses, applies matching IDs, ignores unknown IDs (e.g., id 99), calls `notifyChanged()` only if changed. Matches plan spec exactly.

- **`demoteRunningToPending()` method exists**: PASS — Implemented at `plan-progress.ts:249`. Guards with `hasPlan()`, converts all `running` tasks to `pending`, clears `startedAt`, calls `notifyChanged()` only if changed. Matches plan spec exactly.

- **Tests for all three methods**: PASS — 5 tests in `describe("task status snapshot and recovery", ...)` at `tests/plan-progress.test.ts:503`:
  1. `getTaskStatuses returns current statuses keyed by task id` — verifies completed + running statuses
  2. `restoreTaskStatuses preserves matching tasks and ignores unknown ids` — verifies completed/failed counts with unknown id 99 ignored
  3. `restoreTaskStatuses ignores statuses when no plan is loaded` — verifies no-op when no plan
  4. `demoteRunningToPending converts all running tasks to pending` — verifies running→pending conversion, count reset
  5. `demoteRunningToPending is no-op when no plan is loaded` — verifies no throw

- **All existing tests still pass**: PASS — Full `plan-progress.test.ts` suite: 26 passed, 0 failed.

- **Build succeeds**: PASS — `npm run build` (tsc --noEmit) exits with no errors.

## Test Results

- `npm test -- --run tests/plan-progress.test.ts -t "task status snapshot and recovery"`: PASS (5 passed, 21 skipped)
- `npm test -- --run tests/plan-progress.test.ts`: PASS (26 passed, 0 failed)
- `npm run build`: PASS (no errors)

## Residual Issues

- None. No TODO/FIXME/console.log found in modified files.
