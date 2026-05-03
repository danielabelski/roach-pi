import { describe, expect, it, vi } from "vitest";
import { MilestoneTracker, extractMilestoneId, parseStateMd, isMilestoneDirectoryPath, parseTodoMd, isTodoFilePath } from "../milestone-tracker.js";
import { RoachFooter } from "../footer.js";
import { PlanProgressTracker } from "../plan-progress.js";

const stubTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

describe("extractMilestoneId", () => {
  it("extracts id and name from milestone file paths", () => {
    expect(extractMilestoneId("M1-async-spawn-foundation.md")).toEqual({
      id: "M1",
      name: "Async Spawn Foundation",
    });
    expect(extractMilestoneId("M2-status-query-interrupt.md")).toEqual({
      id: "M2",
      name: "Status Query Interrupt",
    });
    expect(extractMilestoneId("docs/harness/milestones/M3-completion-notification.md")).toEqual({
      id: "M3",
      name: "Completion Notification",
    });
  });

  it("normalizes id to uppercase", () => {
    expect(extractMilestoneId("m1-lower-case.md")).toEqual({
      id: "M1",
      name: "Lower Case",
    });
  });

  it("returns null for non-milestone paths", () => {
    expect(extractMilestoneId("state.md")).toBeNull();
    expect(extractMilestoneId("plan.md")).toBeNull();
    expect(extractMilestoneId("M.md")).toBeNull();
    expect(extractMilestoneId("")).toBeNull();
  });
});

describe("MilestoneTracker lifecycle", () => {
  it("loads milestones and initializes all as pending", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "Foundation" },
      { id: "M2", name: "Integration" },
      { id: "M3", name: "Verification" },
    ]);

    expect(tracker.hasMilestones()).toBe(true);
    expect(tracker.getMilestoneStatuses()).toEqual([
      { id: "M1", status: "pending" },
      { id: "M2", status: "pending" },
      { id: "M3", status: "pending" },
    ]);
  });

  it("transitions milestone status", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "Foundation" },
      { id: "M2", name: "Integration" },
    ]);

    tracker.startMilestone("M1");
    expect(tracker.getMilestone("M1")?.status).toBe("executing");

    tracker.completeMilestone("M1", true);
    expect(tracker.getMilestone("M1")?.status).toBe("completed");
  });

  it("marks milestone as failed on failure", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([{ id: "M1", name: "Foundation" }]);

    tracker.startMilestone("M1");
    tracker.completeMilestone("M1", false);
    expect(tracker.getMilestone("M1")?.status).toBe("failed");
  });

  it("ignores transitions for unknown milestones", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([{ id: "M1", name: "Foundation" }]);

    tracker.startMilestone("M99");
    tracker.completeMilestone("M99", true);
    expect(tracker.getMilestone("M99")).toBeUndefined();
  });

  it("ignores invalid transitions", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([{ id: "M1", name: "Foundation" }]);

    tracker.completeMilestone("M1", true);
    expect(tracker.getMilestone("M1")?.status).toBe("pending");

    tracker.startMilestone("M1");
    expect(tracker.getMilestone("M1")?.status).toBe("executing");

    tracker.startMilestone("M1");
    expect(tracker.getMilestone("M1")?.status).toBe("executing");
  });

  it("notifies subscribers on state changes", () => {
    const tracker = new MilestoneTracker();
    const onChange = vi.fn();
    tracker.setOnChange(onChange);

    tracker.loadMilestones([{ id: "M1", name: "Foundation" }]);
    expect(onChange).toHaveBeenCalledTimes(1);

    tracker.startMilestone("M1");
    expect(onChange).toHaveBeenCalledTimes(2);

    tracker.completeMilestone("M1", true);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("does not notify for no-op transitions", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([{ id: "M1", name: "Foundation" }]);
    const onChange = vi.fn();
    tracker.setOnChange(onChange);

    tracker.startMilestone("M1");
    tracker.startMilestone("M1"); // no-op
    tracker.startMilestone("M99"); // unknown

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("clear resets all milestones", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([{ id: "M1", name: "Foundation" }]);
    tracker.startMilestone("M1");

    tracker.clear();
    expect(tracker.hasMilestones()).toBe(false);
    expect(tracker.getMilestoneStatuses()).toEqual([]);
  });
});

describe("MilestoneTracker.loadFromPaths", () => {
  it("loads milestones from file paths", () => {
    const tracker = new MilestoneTracker();
    tracker.loadFromPaths([
      "docs/harness/milestones/M1-async-spawn-foundation.md",
      "docs/harness/milestones/M2-status-query-interrupt.md",
      "docs/harness/milestones/M3-completion-notification.md",
      "docs/harness/state.md", // not a milestone
    ]);

    expect(tracker.getMilestoneStatuses()).toEqual([
      { id: "M1", status: "pending" },
      { id: "M2", status: "pending" },
      { id: "M3", status: "pending" },
    ]);
  });

  it("deduplicates by id", () => {
    const tracker = new MilestoneTracker();
    tracker.loadFromPaths([
      "path/M1-first.md",
      "other/M1-duplicate.md",
    ]);

    expect(tracker.getMilestoneStatuses()).toEqual([
      { id: "M1", status: "pending" },
    ]);
  });
});

describe("MilestoneTracker.mergeFromPaths", () => {
  it("adds new milestones without resetting existing status", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([{ id: "M1", name: "Foundation" }]);
    tracker.startMilestone("M1");

    tracker.mergeFromPaths([
      "M1-anything.md",
      "M2-new-milestone.md",
    ]);

    expect(tracker.getMilestone("M1")?.status).toBe("executing");
    expect(tracker.getMilestone("M2")?.status).toBe("pending");
  });

  it("sorts milestones by id numerically", () => {
    const tracker = new MilestoneTracker();
    tracker.loadFromPaths(["M10-tenth.md", "M2-second.md", "M1-first.md"]);

    expect(tracker.getMilestoneStatuses().map((m) => m.id)).toEqual(["M1", "M2", "M10"]);
  });
});

describe("MilestoneTracker.getSummary", () => {
  it("counts statuses correctly", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "A" },
      { id: "M2", name: "B" },
      { id: "M3", name: "C" },
      { id: "M4", name: "D" },
      { id: "M5", name: "E" },
    ]);

    tracker.startMilestone("M1");
    tracker.completeMilestone("M1", true);
    tracker.startMilestone("M2");
    tracker.startMilestone("M3");
    tracker.setStatus("M4", "skipped");

    const summary = tracker.getSummary();
    expect(summary).toEqual({
      completed: 1,
      total: 5,
      failed: 0,
      running: 2,
      pending: 1,
      skipped: 1,
    });
  });
});

describe("MilestoneTracker.render", () => {
  it("returns empty when no milestones", () => {
    const tracker = new MilestoneTracker();
    expect(tracker.render(stubTheme, 80)).toEqual([]);
  });

  it("renders milestone summary with icons", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "Foundation" },
      { id: "M2", name: "Integration" },
      { id: "M3", name: "Verification" },
    ]);

    tracker.startMilestone("M1");
    tracker.completeMilestone("M1", true);
    tracker.startMilestone("M2");

    const lines = tracker.render(stubTheme, 80);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("1/3"); // progress
    expect(lines[1]).toContain("M1"); // milestone icons
    expect(lines[1]).toContain("M2");
    expect(lines[1]).toContain("M3");
    expect(lines.join("\n")).toContain("✓");
    expect(lines.join("\n")).toContain("▶");
    expect(lines.join("\n")).toContain("○");
  });

  it("shows failed count when milestones fail", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "A" },
      { id: "M2", name: "B" },
    ]);

    tracker.startMilestone("M1");
    tracker.completeMilestone("M1", false);

    const lines = tracker.render(stubTheme, 80);
    expect(lines[0]).toContain("1✗");
  });

  it("shows skipped count when milestones are skipped", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "A" },
      { id: "M2", name: "B" },
    ]);

    tracker.setStatus("M1", "skipped");

    const lines = tracker.render(stubTheme, 80);
    expect(lines[0]).toContain("1⏭");
  });

  it("never produces a line wider than maxWidth", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "A" },
      { id: "M2", name: "B" },
      { id: "M3", name: "C" },
      { id: "M4", name: "D" },
      { id: "M5", name: "E" },
    ]);
    tracker.startMilestone("M3");

    for (const maxWidth of [1, 4, 8, 12, 40, 80, 176]) {
      const lines = tracker.render(stubTheme, maxWidth);
      for (const line of lines) {
        // Count visible characters (strip ANSI-like sequences from theme stub)
        const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
        expect([...visible].length).toBeLessThanOrEqual(maxWidth);
      }
    }
  });
});

describe("MilestoneTracker with RoachFooter", () => {
  function makeSamplePlan(): string {
    return [
      "# Test Plan",
      "",
      "**Goal:** Test milestone + plan integration",
      "",
      "**Verification Strategy:**",
      "- **Level:** test-suite",
      "- **Command:** `npx vitest run`",
      "- **What it validates:** Tests pass",
      "",
      "---",
      "",
      "### Task 1: Do something",
      "",
      "**Dependencies:** None",
      "**Files:**",
      "- Modify: `a.ts`",
      "",
      "- [ ] **Step 1: Run**",
      "",
    ].join("\n");
  }

  it("renders milestone summary above plan tasks", () => {
    const milestoneTracker = new MilestoneTracker();
    milestoneTracker.loadMilestones([
      { id: "M1", name: "Foundation" },
      { id: "M2", name: "Integration" },
    ]);
    milestoneTracker.startMilestone("M1");

    const planTracker = new PlanProgressTracker();
    planTracker.loadPlan(makeSamplePlan());

    const footer = new RoachFooter(
      stubTheme,
      { getGitBranch: () => "main" } as any,
      {
        cwd: "/tmp/project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
      },
      { totalInput: 10, totalCacheRead: 0 },
      { running: new Map() },
      planTracker,
      null,
      milestoneTracker,
    );

    const lines = footer.render(80);
    const text = lines.join("\n");

    // Milestone summary should be present
    expect(text).toContain("M1");
    expect(text).toContain("M2");

    // Plan tasks should also be present
    expect(text).toContain("Do something");
  });

  it("renders milestone summary alone when no plan is loaded", () => {
    const milestoneTracker = new MilestoneTracker();
    milestoneTracker.loadMilestones([
      { id: "M1", name: "Foundation" },
      { id: "M2", name: "Integration" },
    ]);
    milestoneTracker.startMilestone("M1");
    milestoneTracker.completeMilestone("M1", true);

    const footer = new RoachFooter(
      stubTheme,
      { getGitBranch: () => "main" } as any,
      {
        cwd: "/tmp/project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
      },
      { totalInput: 10, totalCacheRead: 0 },
      { running: new Map() },
      null, // no plan
      null,
      milestoneTracker,
    );

    const lines = footer.render(80);
    const text = lines.join("\n");

    expect(text).toContain("M1");
    expect(text).toContain("M2");
    expect(text).toContain("1/2");
  });

  it("renders normally without milestone tracker", () => {
    const planTracker = new PlanProgressTracker();
    planTracker.loadPlan(makeSamplePlan());

    const footer = new RoachFooter(
      stubTheme,
      { getGitBranch: () => "main" } as any,
      {
        cwd: "/tmp/project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
      },
      { totalInput: 10, totalCacheRead: 0 },
      { running: new Map() },
      planTracker,
    );

    const lines = footer.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("Do something");
  });

  it("notifies TUI on milestone state change", () => {
    const milestoneTracker = new MilestoneTracker();
    const requestRender = vi.fn();

    const footer = new RoachFooter(
      stubTheme,
      { getGitBranch: () => "main" } as any,
      {
        cwd: "/tmp/project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
      },
      { totalInput: 10, totalCacheRead: 0 },
      { running: new Map() },
      null,
      { requestRender } as any,
      milestoneTracker,
    );

    milestoneTracker.loadMilestones([{ id: "M1", name: "Foundation" }]);
    expect(requestRender).toHaveBeenCalled();

    footer.dispose();
  });
});

describe("parseStateMd", () => {
  it("parses table row format", () => {
    const stateMd = [
      "# Long Run Status: Async Subagent Features",
      "",
      "| ID | Name | Status | Attempts | Dependencies | Plan File | Review File |",
      "|----|------|--------|----------|-------------|-----------|-------------|",
      "| M1 | Async Spawn Foundation | completed | 1 | — | docs/engineering-discipline/plans/2026-05-03-m1-async-spawn-foundation.md | — |",
      "| M2 | Status Query & Interrupt | executing | 1 | M1 | docs/engineering-discipline/plans/2026-05-03-m2-status-query-interrupt.md | — |",
      "| M3 | Completion Notification | pending | 0 | M2 | — | — |",
      "| M4 | Tool Schema & Live Progress | pending | 0 | M3 | — | — |",
    ].join("\n");

    const parsed = parseStateMd(stateMd);
    expect(parsed).toEqual([
      { id: "M1", name: "Async Spawn Foundation", status: "completed" },
      { id: "M2", name: "Status Query & Interrupt", status: "executing" },
      { id: "M3", name: "Completion Notification", status: "pending" },
      { id: "M4", name: "Tool Schema & Live Progress", status: "pending" },
    ]);
  });

  it("parses table with box drawing characters", () => {
    const stateMd = [
      "┌────┬─────────────────────────────┬──────────────┐",
      "│ ID │ Name                        │ Status       │",
      "├────┼─────────────────────────────┼──────────────┤",
      "│ M1 │ Async Spawn Foundation      │ ✅ completed │",
      "├────┼─────────────────────────────┼──────────────┤",
      "│ M2 │ Status Query & Interrupt    │ ✅ completed │",
      "├────┼─────────────────────────────┼──────────────┤",
      "│ M3 │ Completion Notification     │ ⏳ ready     │",
      "├────┼─────────────────────────────┼──────────────┤",
      "│ M4 │ Tool Schema & Live Progress │ ○ pending    │",
      "└────┴─────────────────────────────┴──────────────┘",
    ].join("\n");

    const parsed = parseStateMd(stateMd);
    expect(parsed).toEqual([
      { id: "M1", name: "Async Spawn Foundation", status: "completed" },
      { id: "M2", name: "Status Query & Interrupt", status: "completed" },
      { id: "M3", name: "Completion Notification", status: "pending" },
      { id: "M4", name: "Tool Schema & Live Progress", status: "pending" },
    ]);
  });

  it("returns empty for non-state markdown", () => {
    expect(parseStateMd("# Just a regular document\nNothing here")).toEqual([]);
  });
});

describe("isMilestoneDirectoryPath", () => {
  it("detects milestones/ directory paths", () => {
    expect(isMilestoneDirectoryPath("docs/harness/milestones/M1-foundation.md")).toBe(true);
    expect(isMilestoneDirectoryPath("milestones/M2-integration.md")).toBe(true);
    expect(isMilestoneDirectoryPath("a/b/milestones/M3-verify.md")).toBe(true);
  });

  it("rejects non-milestone paths", () => {
    expect(isMilestoneDirectoryPath("state.md")).toBe(false);
    expect(isMilestoneDirectoryPath("plans/M1-foundation.md")).toBe(false);
    expect(isMilestoneDirectoryPath("docs/reviews/M1-review.md")).toBe(false);
  });
});

describe("parseTodoMd", () => {
  it("parses checkbox items", () => {
    const todoMd = [
      "# Implementation Plan",
      "",
      "## Tasks",
      "",
      "- [x] **Task 1: Create MilestoneTracker** ",
      "- [x] **Task 2: Extend footer rendering**",
      "- [ ] **Task 3: Wire into extension lifecycle**",
      "- [ ] **Task 4: Tests**",
    ].join("\n");

    const tasks = parseTodoMd(todoMd);
    expect(tasks).toEqual([
      { name: "Task 1: Create MilestoneTracker", done: true },
      { name: "Task 2: Extend footer rendering", done: true },
      { name: "Task 3: Wire into extension lifecycle", done: false },
      { name: "Task 4: Tests", done: false },
    ]);
  });

  it("handles mixed checkbox styles", () => {
    const todoMd = [
      "- [X] Done with uppercase X",
      "- [x] Done with lowercase x",
      "- [ ] Not done",
    ].join("\n");

    const tasks = parseTodoMd(todoMd);
    expect(tasks).toEqual([
      { name: "Done with uppercase X", done: true },
      { name: "Done with lowercase x", done: true },
      { name: "Not done", done: false },
    ]);
  });

  it("returns empty for non-todo content", () => {
    expect(parseTodoMd("# Just a document\nNo checkboxes here")).toEqual([]);
  });
});

describe("isTodoFilePath", () => {
  it("detects todo.md paths", () => {
    expect(isTodoFilePath("todo.md")).toBe(true);
    expect(isTodoFilePath("docs/todo.md")).toBe(true);
    expect(isTodoFilePath("a/b/c/todo.md")).toBe(true);
    expect(isTodoFilePath("TODO.md")).toBe(true);
  });

  it("rejects non-todo paths", () => {
    expect(isTodoFilePath("state.md")).toBe(false);
    expect(isTodoFilePath("plan.md")).toBe(false);
    expect(isTodoFilePath("tasks.md")).toBe(false);
  });
});

describe("MilestoneTracker task rendering", () => {
  it("renders task progress from todo.md", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "Foundation" },
      { id: "M2", name: "Integration" },
    ]);
    tracker.startMilestone("M1");
    tracker.updateActiveTasks([
      { name: "Task 1: Create types", done: true },
      { name: "Task 2: Implement core", done: true },
      { name: "Task 3: Add tests", done: false },
      { name: "Task 4: Verify", done: false },
    ]);

    const lines = tracker.render(stubTheme, 80);
    const text = lines.join("\n");

    expect(text).toContain("2/4"); // task progress
    expect(text).toContain("Task 1: Create types");
    expect(text).toContain("Task 3: Add tests");
  });

  it("shows task icons correctly", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([{ id: "M1", name: "A" }]);
    tracker.startMilestone("M1");
    tracker.updateActiveTasks([
      { name: "Done task", done: true },
      { name: "Pending task", done: false },
    ]);

    const lines = tracker.render(stubTheme, 80);
    const text = lines.join("\n");

    expect(text).toContain("\u2713"); // ✓ for done
    expect(text).toContain("\u25CB"); // ○ for pending
  });

  it("limits displayed tasks to 5", () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([{ id: "M1", name: "A" }]);
    tracker.startMilestone("M1");
    tracker.updateActiveTasks([
      { name: "Task 1", done: true },
      { name: "Task 2", done: true },
      { name: "Task 3", done: false },
      { name: "Task 4", done: false },
      { name: "Task 5", done: false },
      { name: "Task 6", done: false },
      { name: "Task 7", done: false },
    ]);

    const lines = tracker.render(stubTheme, 80);
    const text = lines.join("\n");

    expect(text).toContain("Task 5");
    expect(text).toContain("... +2 more");
    expect(text).not.toContain("Task 6");
  });
});

describe("Bug reproduction: box drawing table parsing", () => {
  // Exact state.md format from the user's session
  const USER_STATE_MD = [
    "Long Run Status",
    "",
    " Progress: 2/4 milestones completed",
    " Next up: M3 (Completion Notification)",
    "",
    " ┌────┬─────────────────────────────┬──────────────┐",
    " │ ID │ Name                        │ Status       │",
    " ├────┼─────────────────────────────┼──────────────┤",
    " │ M1 │ Async Spawn Foundation      │ ✅ completed │",
    " ├────┼─────────────────────────────┼──────────────┤",
    " │ M2 │ Status Query & Interrupt    │ ✅ completed │",
    " ├────┼─────────────────────────────┼──────────────┤",
    " │ M3 │ Completion Notification     │ ⏳ ready     │",
    " ├────┼─────────────────────────────┼──────────────┤",
    " │ M4 │ Tool Schema & Live Progress │ ○ pending    │",
    " └────┴─────────────────────────────┴──────────────┘",
    "",
    " M3를 시작할까요?",
  ].join("\n");

  it("parses exactly 4 milestones from box drawing table", () => {
    const parsed = parseStateMd(USER_STATE_MD);
    expect(parsed).toHaveLength(4);
    expect(parsed.map((m) => m.id)).toEqual(["M1", "M2", "M3", "M4"]);
  });

  it("correctly identifies M1 and M2 as completed", () => {
    const parsed = parseStateMd(USER_STATE_MD);
    expect(parsed.find((m) => m.id === "M1")?.status).toBe("completed");
    expect(parsed.find((m) => m.id === "M2")?.status).toBe("completed");
  });

  it("correctly identifies M3 as pending (ready maps to pending)", () => {
    const parsed = parseStateMd(USER_STATE_MD);
    expect(parsed.find((m) => m.id === "M3")?.status).toBe("pending");
  });

  it("correctly identifies M4 as pending", () => {
    const parsed = parseStateMd(USER_STATE_MD);
    expect(parsed.find((m) => m.id === "M4")?.status).toBe("pending");
  });

  it("does NOT create phantom milestones M5-M7", () => {
    const parsed = parseStateMd(USER_STATE_MD);
    expect(parsed.find((m) => m.id === "M5")).toBeUndefined();
    expect(parsed.find((m) => m.id === "M6")).toBeUndefined();
    expect(parsed.find((m) => m.id === "M7")).toBeUndefined();
  });

  it("full scenario: load from state.md and render footer", () => {
    const milestoneTracker = new MilestoneTracker();
    const parsed = parseStateMd(USER_STATE_MD);

    // Load milestones from parsed state
    milestoneTracker.loadMilestones(parsed.map((m) => ({ id: m.id, name: m.name })));
    for (const m of parsed) {
      milestoneTracker.setStatus(m.id, m.status);
    }

    // Verify correct count
    expect(milestoneTracker.getMilestoneStatuses()).toHaveLength(4);

    // Verify render output
    const lines = milestoneTracker.render(stubTheme, 200);
    const text = lines.join("\n");

    // Should show 4 milestones, not 7
    expect(text).toContain("M1");
    expect(text).toContain("M2");
    expect(text).toContain("M3");
    expect(text).toContain("M4");
    expect(text).not.toContain("M5");
    expect(text).not.toContain("M6");
    expect(text).not.toContain("M7");

    // Should show correct progress: 2/4
    expect(text).toContain("2/4");
  });
});
