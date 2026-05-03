# Progress Tracker QA Implementation Plan

> **Worker note:** Execute this plan task-by-task using the agentic-run-plan skill or subagents. Each step uses checkbox (`- [ ]`) syntax for progress tracking.

**Goal:** Verify that the agentic-harness progress tracker correctly handles all plan parsing, state transitions, fuzzy matching, event wiring, TUI rendering, and edge cases — fixing any bugs found.

**Architecture:** The progress tracker is a 4-layer system: (1) `plan-parser.ts` extracts structured task data from markdown, (2) `plan-progress.ts` maintains in-memory task status with state machine transitions, (3) `plan-progress-events.ts` wires pi tool lifecycle events to tracker operations, (4) `footer.ts` renders live progress in the TUI. Current tests cover 62 cases across 4 test files. This plan adds targeted QA tests for uncovered edge cases and verifies the system works end-to-end.

**Tech Stack:** TypeScript, vitest, pi extension API

**Work Scope:**
- **In scope:**
  - Identify and test uncovered edge cases in plan parsing, tracker state machine, fuzzy matching, event wiring, and rendering
  - Verify existing behavior through additional targeted tests
  - Fix any bugs discovered during testing
  - Ensure all 4 source modules (`plan-parser.ts`, `plan-progress.ts`, `plan-progress-events.ts`, `validator-template.ts`) have comprehensive test coverage
- **Out of scope:**
  - Refactoring existing working code
  - Adding new features to the progress tracker
  - Changes to skill markdown files (SKILL.md)
  - TUI visual/manual testing (automated render tests only)

**Verification Strategy:**
- **Level:** test-suite
- **Command:** `npx vitest run extensions/agentic-harness/tests/plan-parser.test.ts extensions/agentic-harness/tests/plan-progress.test.ts extensions/agentic-harness/tests/plan-progress-events.test.ts extensions/agentic-harness/tests/validator-template.test.ts`
- **What it validates:** All progress tracker unit tests pass, including new edge-case tests

---

### Task 1: Plan Parser Edge Cases

**Dependencies:** None (can run in parallel)
**Files:**
- Modify: `extensions/agentic-harness/tests/plan-parser.test.ts`

- [ ] **Step 1: Write edge-case tests for plan parsing**

Add the following tests to `extensions/agentic-harness/tests/plan-parser.test.ts`:

```typescript
describe("parsePlan edge cases", () => {
  it("should handle tasks with no files section", () => {
    const md = [
      "# Plan",
      "",
      "**Goal:** Test edge case",
      "",
      "### Task 1: No files task",
      "",
      "**Dependencies:** None",
      "**Files:**",
      "",
      "- [ ] **Step 1: Do something**",
      "",
      "Run: `echo hello`",
      "Expected: hello",
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].files).toEqual([]);
    expect(plan.tasks[0].testCommands).toContain("echo hello");
  });

  it("should handle tasks with no steps (no - [ ] Step markers)", () => {
    const md = [
      "# Plan",
      "",
      "**Goal:** Empty steps",
      "",
      "### Task 1: Empty task",
      "",
      "**Dependencies:** None",
      "**Files:**",
      "- Create: `src/a.ts`",
      "",
      "No steps here.",
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].fullStepsText).toBe("");
  });

  it("should handle tasks with multiple Run/Expected pairs", () => {
    const md = [
      "# Plan",
      "",
      "**Goal:** Multi-run task",
      "",
      "### Task 1: Multi run",
      "",
      "**Dependencies:** None",
      "**Files:**",
      "- Create: `src/a.ts`",
      "",
      "- [ ] **Step 1: Run first**",
      "",
      "Run: `cmd1`",
      "Expected: result1",
      "",
      "- [ ] **Step 2: Run second**",
      "",
      "Run: `cmd2`",
      "Expected: result2",
      "",
      "Run: `cmd3`",
      "Expected: result3",
    ].join("\n");

    const plan = parsePlan(md);
    const t = plan.tasks[0];
    expect(t.testCommands).toEqual(["cmd1", "cmd2", "cmd3"]);
    expect(t.acceptanceCriteria).toEqual([
      "cmd1 → result1",
      "cmd2 → result2",
      "cmd3 → result3",
    ]);
  });

  it("should handle file paths with line ranges", () => {
    const md = [
      "# Plan",
      "",
      "**Goal:** Line ranges",
      "",
      "### Task 1: Modify range",
      "",
      "**Dependencies:** None",
      "**Files:**",
      "- Modify: `src/file.ts:10-25`",
      "- Create: `src/new.ts`",
      "",
      "- [ ] **Step 1: Do it**",
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan.tasks[0].files).toContain("src/file.ts");
    expect(plan.tasks[0].files).toContain("src/new.ts");
    expect(plan.tasks[0].files).not.toContain("src/file.ts:10-25");
  });

  it("should handle non-contiguous task numbers", () => {
    const md = [
      "# Plan",
      "",
      "**Goal:** Gaps",
      "",
      "### Task 1: First",
      "",
      "**Dependencies:** None",
      "**Files:**",
      "",
      "- [ ] **Step 1: Do it**",
      "",
      "### Task 5: Second",
      "",
      "**Dependencies:** None",
      "**Files:**",
      "",
      "- [ ] **Step 1: Do it**",
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].id).toBe(1);
    expect(plan.tasks[1].id).toBe(5);
  });

  it("should handle Run without Expected on next line", () => {
    const md = [
      "# Plan",
      "",
      "**Goal:** Run only",
      "",
      "### Task 1: Run without expected",
      "",
      "**Dependencies:** None",
      "**Files:**",
      "",
      "- [ ] **Step 1: Run it**",
      "",
      "Run: `cmd`",
      "",
      "- [ ] **Step 2: Done**",
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan.tasks[0].testCommands).toEqual(["cmd"]);
    expect(plan.tasks[0].acceptanceCriteria).toEqual([]);
  });

  it("should handle duplicate file paths (deduplication)", () => {
    const md = [
      "# Plan",
      "",
      "**Goal:** Dup files",
      "",
      "### Task 1: Dup",
      "",
      "**Dependencies:** None",
      "**Files:**",
      "- Create: `src/a.ts`",
      "- Modify: `src/a.ts`",
      "- Test: `src/a.ts`",
      "",
      "- [ ] **Step 1: Do it**",
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan.tasks[0].files).toEqual(["src/a.ts"]);
  });

  it("should handle empty plan (no tasks, no goal)", () => {
    const plan = parsePlan("");
    expect(plan.goal).toBe("");
    expect(plan.tasks).toEqual([]);
    expect(plan.verificationCommand).toBe("");
  });

  it("should extract verification command with complex content", () => {
    const md = [
      "# Plan",
      "",
      "**Goal:** Complex cmd",
      "",
      "**Verification Strategy:**",
      "- **Level:** test-suite",
      "- **Command:** `npx vitest run --reporter=verbose`",
      "",
      "### Task 1: Do it",
      "",
      "**Dependencies:** None",
      "**Files:**",
      "",
      "- [ ] **Step 1: Step**",
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan.verificationCommand).toBe("npx vitest run --reporter=verbose");
  });
});
```

- [ ] **Step 2: Run parser tests to verify they pass**

Run: `cd extensions/agentic-harness && npx vitest run tests/plan-parser.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add extensions/agentic-harness/tests/plan-parser.test.ts
git commit -m "test: add plan parser edge-case tests for QA verification"
```

---

### Task 2: Progress Tracker State Machine Edge Cases

**Dependencies:** None (can run in parallel)
**Files:**
- Modify: `extensions/agentic-harness/tests/plan-progress.test.ts`

- [ ] **Step 1: Write edge-case tests for tracker state machine**

Add the following test sections to `extensions/agentic-harness/tests/plan-progress.test.ts`:

```typescript
describe("PlanProgressTracker edge cases", () => {
  it("returns empty array from render when no plan is loaded", () => {
    const tracker = new PlanProgressTracker();
    expect(tracker.render(stubTheme, 80)).toEqual([]);
    expect(tracker.hasPlan()).toBe(false);
    expect(tracker.getGoal()).toBe("");
    expect(tracker.getProgress()).toEqual({
      completed: 0,
      total: 0,
      failed: 0,
      running: 0,
      pending: 0,
    });
  });

  it("returns empty array from render when maxWidth is 0", () => {
    const tracker = loadSamplePlan();
    expect(tracker.render(stubTheme, 0)).toEqual([]);
  });

  it("clear() does not notify when no plan was loaded", () => {
    const tracker = new PlanProgressTracker();
    const onChange = vi.fn();
    tracker.setOnChange(onChange);
    tracker.clear();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("completeTask on a pending task is a no-op (only running tasks can complete)", () => {
    const tracker = loadSamplePlan();
    const onChange = vi.fn();
    tracker.setOnChange(onChange);

    tracker.completeTask(1, true);

    expect(taskOf(tracker, 1).status).toBe("pending");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("startTaskById returns null for non-existent task ID", () => {
    const tracker = loadSamplePlan();
    expect(tracker.startTaskById(999)).toBeNull();
  });

  it("startTaskById returns the task id when task is already running (idempotent)", () => {
    const tracker = loadSamplePlan();
    tracker.startTaskById(1);
    const result = tracker.startTaskById(1);
    expect(result).toBe(1);
    expect(taskOf(tracker, 1).status).toBe("running");
  });

  it("startTaskById returns null when task is already completed", () => {
    const tracker = loadSamplePlan();
    tracker.startTask(1);
    tracker.completeTask(1, true);
    expect(tracker.startTaskById(1)).toBeNull();
  });

  it("startTaskById returns null when task has failed", () => {
    const tracker = loadSamplePlan();
    tracker.startTask(2);
    tracker.completeTask(2, false);
    expect(tracker.startTaskById(2)).toBeNull();
  });

  it("completeTaskByMatch returns null when no plan is loaded", () => {
    const tracker = new PlanProgressTracker();
    expect(tracker.completeTaskByMatch("anything", true)).toBeNull();
  });

  it("startTaskByMatch returns null when no plan is loaded", () => {
    const tracker = new PlanProgressTracker();
    expect(tracker.startTaskByMatch("anything")).toBeNull();
  });

  it("completeTaskByMatch does not match pending tasks (only running)", () => {
    const tracker = loadSamplePlan();
    expect(tracker.completeTaskByMatch("Load sample plan", true)).toBeNull();
    expect(taskOf(tracker, 1).status).toBe("pending");
  });

  it("fuzzy match handles Korean text gracefully (returns null, no crash)", () => {
    const tracker = loadSamplePlan();
    expect(tracker.startTaskByMatch("계획을 만들기")).toBeNull();
  });

  it("fuzzy match handles empty string", () => {
    const tracker = loadSamplePlan();
    expect(tracker.startTaskByMatch("")).toBeNull();
  });

  it("fuzzy match handles special regex characters in input without crash", () => {
    const tracker = loadSamplePlan();
    expect(tracker.startTaskByMatch("task 1 (regex.*+?)[]{}")).toBe(1);
  });

  it("getSpinner cycles through all 4 frames", () => {
    vi.useFakeTimers();
    const tracker = loadSamplePlan();
    const frames = new Set<string>();

    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(500);
      frames.add(tracker.getSpinner());
    }

    expect(frames.has("◐")).toBe(true);
    expect(frames.has("◓")).toBe(true);
    expect(frames.has("◑")).toBe(true);
    expect(frames.has("◒")).toBe(true);
  });

  it("loading a plan with zero tasks results in hasPlan() returning false", () => {
    const tracker = new PlanProgressTracker();
    tracker.loadPlan("# Not a plan\n\n**Goal:** No tasks\n");
    expect(tracker.hasPlan()).toBe(false);
  });

  it("subscribeOnChange returns an unsubscribe function that stops notifications", () => {
    const tracker = loadSamplePlan();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    const unsub = tracker.subscribeOnChange(listener1);
    tracker.subscribeOnChange(listener2);

    tracker.startTask(1);
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);

    unsub();
    listener1.mockClear();
    listener2.mockClear();

    tracker.completeTask(1, true);
    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tracker tests to verify they pass**

Run: `cd extensions/agentic-harness && npx vitest run tests/plan-progress.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add extensions/agentic-harness/tests/plan-progress.test.ts
git commit -m "test: add progress tracker state machine edge-case tests"
```

---

### Task 3: Event Wiring Edge Cases

**Dependencies:** None (can run in parallel)
**Files:**
- Modify: `extensions/agentic-harness/tests/plan-progress-events.test.ts`

- [ ] **Step 1: Write edge-case tests for event wiring**

Add the following test sections to `extensions/agentic-harness/tests/plan-progress-events.test.ts`:

```typescript
describe("extractPlanPathsFromArgs edge cases", () => {
  it("returns empty array for null/undefined args", () => {
    expect(extractPlanPathsFromArgs(null)).toEqual([]);
    expect(extractPlanPathsFromArgs(undefined)).toEqual([]);
    expect(extractPlanPathsFromArgs({})).toEqual([]);
  });

  it("returns empty array when no plan-like paths are present", () => {
    expect(extractPlanPathsFromArgs({
      agent: "worker",
      task: "do something unrelated",
    })).toEqual([]);
  });

  it("ignores non-string planFile values", () => {
    expect(extractPlanPathsFromArgs({
      planFile: 123,
    })).toEqual([]);
  });

  it("ignores non-array reads values", () => {
    expect(extractPlanPathsFromArgs({
      reads: "not-an-array",
    })).toEqual([]);
  });

  it("deduplicates plan paths across multiple sources", () => {
    const paths = extractPlanPathsFromArgs({
      planFile: PLAN_PATH,
      reads: [PLAN_PATH],
      task: `Execute ${PLAN_PATH}`,
    });
    expect(paths).toEqual([PLAN_PATH]);
  });
});

describe("startPlanSubagentTasks edge cases", () => {
  it("returns empty array when tracker has no plan loaded", () => {
    const tracker = new PlanProgressTracker();
    expect(startPlanSubagentTasks(tracker, {
      agent: "plan-worker",
      task: "Task 1",
    })).toEqual([]);
  });

  it("returns empty array for args with no subagent items", () => {
    const tracker = loadTrackingPlan();
    expect(startPlanSubagentTasks(tracker, {})).toEqual([]);
  });

  it("returns empty array when no tasks match the text", () => {
    const tracker = loadTrackingPlan();
    expect(startPlanSubagentTasks(tracker, {
      agent: "plan-worker",
      task: "completely unrelated task text about zebras",
    })).toEqual([]);
  });
});

describe("completePlanSubagentTasks edge cases", () => {
  it("returns empty array when tracker has no plan loaded", () => {
    const tracker = new PlanProgressTracker();
    expect(completePlanSubagentTasks(tracker, {
      agent: "plan-validator",
      task: "validate",
    }, true)).toEqual([]);
  });

  it("marks tasks failed when subagent fails even for non-plan agents", () => {
    const tracker = loadTrackingPlan();
    const matchedIds = startPlanSubagentTasks(tracker, {
      agent: "worker",
      task: "Task 3",
    });
    expect(matchedIds).toEqual([3]);

    completePlanSubagentTasks(tracker, {
      agent: "worker",
      task: "Task 3",
    }, false, matchedIds);

    expect(tracker.getProgress()).toMatchObject({ failed: 1 });
  });

  it("does not complete tasks for non-validator agents on success without matchedIds", () => {
    const tracker = loadTrackingPlan();
    startPlanSubagentTasks(tracker, {
      agent: "plan-worker",
      task: "Task 1",
    });

    completePlanSubagentTasks(tracker, {
      agent: "plan-worker",
      task: "Task 1",
    }, true);

    expect(tracker.getProgress()).toMatchObject({ running: 1, completed: 0 });
  });
});

describe("loadPlanFromToolResultEvent edge cases", () => {
  it("returns false for non-read/write tool events", async () => {
    const tracker = new PlanProgressTracker();
    const loaded = await loadPlanFromToolResultEvent(tracker, {
      toolName: "bash",
      input: { path: PLAN_PATH },
      content: [{ type: "text", text: samplePlan("Should not load") }],
    });
    expect(loaded).toBe(false);
    expect(tracker.hasPlan()).toBe(false);
  });

  it("returns false when input has no path string", async () => {
    const tracker = new PlanProgressTracker();
    const loaded = await loadPlanFromToolResultEvent(tracker, {
      toolName: "read",
      input: {},
      content: [{ type: "text", text: samplePlan("No path") }],
    });
    expect(loaded).toBe(false);
  });

  it("returns false for write event without string content", async () => {
    const tracker = new PlanProgressTracker();
    const loaded = await loadPlanFromToolResultEvent(tracker, {
      toolName: "write",
      input: { path: PLAN_PATH, content: 123 },
      content: [{ type: "text", text: "Wrote file" }],
    });
    expect(loaded).toBe(false);
  });

  it("returns false for read event with non-text content", async () => {
    const tracker = new PlanProgressTracker();
    const loaded = await loadPlanFromToolResultEvent(tracker, {
      toolName: "read",
      input: { path: PLAN_PATH },
      content: [{ type: "image", data: "base64..." }],
    });
    expect(loaded).toBe(false);
  });

  it("returns false for read event with empty content array", async () => {
    const tracker = new PlanProgressTracker();
    const loaded = await loadPlanFromToolResultEvent(tracker, {
      toolName: "read",
      input: { path: PLAN_PATH },
      content: [],
    });
    expect(loaded).toBe(false);
  });
});

describe("reloadPlanFromSubagentArgs edge cases", () => {
  it("returns false when no plan paths can be extracted", async () => {
    const tracker = new PlanProgressTracker();
    const loaded = await reloadPlanFromSubagentArgs(tracker, {
      agent: "worker",
      task: "unrelated task",
    });
    expect(loaded).toBe(false);
  });

  it("returns false when plan file does not exist on disk", async () => {
    const tracker = new PlanProgressTracker();
    const loaded = await reloadPlanFromSubagentArgs(tracker, {
      agent: "plan-worker",
      task: "Task 1",
      planFile: "docs/engineering-discipline/plans/nonexistent.md",
    });
    expect(loaded).toBe(false);
  });
});
```

- [ ] **Step 2: Run event tests to verify they pass**

Run: `cd extensions/agentic-harness && npx vitest run tests/plan-progress-events.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add extensions/agentic-harness/tests/plan-progress-events.test.ts
git commit -m "test: add event wiring edge-case tests for progress tracker QA"
```

---

### Task 4: Validator Template Edge Cases

**Dependencies:** None (can run in parallel)
**Files:**
- Modify: `extensions/agentic-harness/tests/validator-template.test.ts`

- [ ] **Step 1: Write edge-case tests for validator template**

Add the following tests to `extensions/agentic-harness/tests/validator-template.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildValidatorPrompt } from "../validator-template.js";
import type { PlanTask } from "../plan-parser.js";

function makeTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 1,
    name: "Test Task",
    dependencies: "None",
    files: ["src/main.ts"],
    testCommands: ["npx vitest run"],
    acceptanceCriteria: ["npx vitest run → ALL PASS"],
    isFinal: false,
    fullStepsText: "- [ ] **Step 1: Do it**",
    ...overrides,
  };
}

describe("buildValidatorPrompt", () => {
  it("includes task name in the output", () => {
    const prompt = buildValidatorPrompt(makeTask({ name: "Create types" }));
    expect(prompt).toContain("Create types");
  });

  it("includes files section with all files", () => {
    const prompt = buildValidatorPrompt(makeTask({
      files: ["src/a.ts", "src/b.ts", "tests/a.test.ts"],
    }));
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("src/b.ts");
    expect(prompt).toContain("tests/a.test.ts");
  });

  it("shows 'No specific files listed' when files array is empty", () => {
    const prompt = buildValidatorPrompt(makeTask({ files: [] }));
    expect(prompt).toContain("No specific files listed");
  });

  it("includes acceptance criteria", () => {
    const prompt = buildValidatorPrompt(makeTask({
      acceptanceCriteria: ["cmd1 → PASS", "cmd2 → PASS"],
    }));
    expect(prompt).toContain("cmd1 → PASS");
    expect(prompt).toContain("cmd2 → PASS");
  });

  it("shows default criteria message when acceptance criteria is empty", () => {
    const prompt = buildValidatorPrompt(makeTask({ acceptanceCriteria: [] }));
    expect(prompt).toContain("All files listed above exist and contain correct implementation");
  });

  it("includes test commands", () => {
    const prompt = buildValidatorPrompt(makeTask({
      testCommands: ["npm test", "npm run lint"],
    }));
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("npm run lint");
  });

  it("shows 'No specific test commands' when testCommands is empty", () => {
    const prompt = buildValidatorPrompt(makeTask({ testCommands: [] }));
    expect(prompt).toContain("No specific test commands for this task.");
  });

  it("includes verification command when provided", () => {
    const prompt = buildValidatorPrompt(makeTask(), "npx vitest --run");
    expect(prompt).toContain("Full Test Suite");
    expect(prompt).toContain("npx vitest --run");
  });

  it("omits full test suite section when no verification command", () => {
    const prompt = buildValidatorPrompt(makeTask());
    expect(prompt).not.toContain("Full Test Suite");
  });

  it("includes PASS and FAIL verdict instructions", () => {
    const prompt = buildValidatorPrompt(makeTask());
    expect(prompt).toContain("PASS");
    expect(prompt).toContain("FAIL");
  });

  it("includes review process steps", () => {
    const prompt = buildValidatorPrompt(makeTask());
    expect(prompt).toContain("Read each file");
    expect(prompt).toContain("Run every test command");
    expect(prompt).toContain("Run the full test suite");
  });
});
```

- [ ] **Step 2: Run validator template tests to verify they pass**

Run: `cd extensions/agentic-harness && npx vitest run tests/validator-template.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add extensions/agentic-harness/tests/validator-template.test.ts
git commit -m "test: add validator template edge-case tests for QA verification"
```

---

### Task 5 (Final): End-to-End Verification

**Dependencies:** All preceding tasks
**Files:** None (read-only verification)

- [ ] **Step 1: Run the full progress tracker test suite**

Run: `cd extensions/agentic-harness && npx vitest run tests/plan-parser.test.ts tests/plan-progress.test.ts tests/plan-progress-events.test.ts tests/validator-template.test.ts`
Expected: ALL PASS — no failures

- [ ] **Step 2: Verify TypeScript compilation is clean**

Run: `cd extensions/agentic-harness && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run the full extension test suite for regressions**

Run: `cd extensions/agentic-harness && npx vitest run`
Expected: No regressions — all pre-existing tests still pass

- [ ] **Step 4: Verify plan success criteria**

Check each criterion:
- [ ] Plan parser handles: empty plans, non-contiguous task IDs, missing files/steps, duplicate files, Run without Expected, file paths with line ranges
- [ ] Tracker state machine handles: null/empty inputs, transition guards, idempotent operations, completed/failed task restart prevention, spinner cycling, subscribe/unsubscribe
- [ ] Event wiring handles: null/undefined args, non-read/write tools, missing paths, non-string content, missing plan files on disk, non-validator agent success behavior
- [ ] Validator template handles: empty files, empty criteria, empty test commands, with/without verification command
- [ ] No bugs were found (all tests pass on first run) OR bugs were identified and fixed
