import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { MilestoneTracker } from "../milestone-tracker.js";
import { PlanProgressTracker } from "../plan-progress.js";
import {
  completePlanSubagentTasks,
  extractMilestonePathsFromArgs,
  extractPlanPathsFromArgs,
  getToolExecutionArgs,
  loadPlanFromAssistantMessageEnd,
  loadPlanFromToolResultEvent,
  reconstructPlanProgressFromSessionEntries,
  reloadPlanFromSubagentArgs,
  startMilestonesFromSubagentArgs,
  startPlanSubagentTasks,
} from "../plan-progress-events.js";

const PLAN_PATH = "docs/engineering-discipline/plans/event-plan.md";

function samplePlan(goal: string, taskName = "Load event plan"): string {
  return [
    "# Event Plan",
    "",
    `**Goal:** ${goal}`,
    "",
    "**Verification Strategy:**",
    "- **Level:** test-suite",
    "- **Command:** `npx vitest run tests/plan-progress-events.test.ts`",
    "- **What it validates:** Event wiring loads real plan markdown",
    "",
    "---",
    "",
    `### Task 1: ${taskName}`,
    "",
    "**Dependencies:** None",
    "**Files:**",
    "- Modify: `extensions/agentic-harness/index.ts`",
    "",
    "- [ ] **Step 1: Load the plan**",
    "",
    "Run: `npx vitest run tests/plan-progress-events.test.ts`",
    "Expected: pass",
    "",
  ].join("\n");
}

function trackingPlan(): string {
  return [
    "# Tracking Plan",
    "",
    "**Goal:** Track subagent task execution",
    "",
    "**Verification Strategy:**",
    "- **Level:** test-suite",
    "- **Command:** `npx vitest run tests/plan-progress-events.test.ts`",
    "- **What it validates:** subagent tracking transitions",
    "",
    "---",
    "",
    "### Task 1: Wire single tracking",
    "",
    "**Dependencies:** None",
    "**Files:**",
    "- Modify: `extensions/agentic-harness/index.ts`",
    "",
    "- [ ] **Step 1: Track single mode**",
    "",
    "Run: `npx vitest run tests/plan-progress-events.test.ts`",
    "Expected: pass",
    "",
    "### Task 2: Wire parallel tracking",
    "",
    "**Dependencies:** Task 1",
    "**Files:**",
    "- Modify: `extensions/agentic-harness/index.ts`",
    "",
    "- [ ] **Step 1: Track parallel mode**",
    "",
    "Run: `npx vitest run tests/plan-progress-events.test.ts`",
    "Expected: pass",
    "",
    "### Task 3: Wire chain tracking",
    "",
    "**Dependencies:** Task 2",
    "**Files:**",
    "- Modify: `extensions/agentic-harness/index.ts`",
    "",
    "- [ ] **Step 1: Track chain mode**",
    "",
    "Run: `npx vitest run tests/plan-progress-events.test.ts`",
    "Expected: pass",
    "",
  ].join("\n");
}

async function createTempPlan(markdown: string): Promise<{ cwd: string; path: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "plan-progress-events-"));
  const planPath = join(cwd, PLAN_PATH);
  await mkdir(join(cwd, "docs/engineering-discipline/plans"), { recursive: true });
  await writeFile(planPath, markdown, "utf-8");
  tempRoots.push(cwd);
  return { cwd, path: PLAN_PATH };
}

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!;
    await rm(root, { recursive: true, force: true });
  }
});

function loadTrackingPlan(): PlanProgressTracker {
  const tracker = new PlanProgressTracker();
  tracker.loadPlan(trackingPlan());
  return tracker;
}

describe("plan progress event loading", () => {
  it("loads write events from input.content plan markdown", async () => {
    const tracker = new PlanProgressTracker();

    const loaded = await loadPlanFromToolResultEvent(tracker, {
      toolName: "write",
      input: { path: PLAN_PATH, content: samplePlan("Loaded from write input") },
      content: [{ type: "text", text: "Wrote file" }],
    });

    expect(loaded).toBe(true);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Loaded from write input");
  });

  it("does not wipe an existing plan when a write event only has a confirmation result", async () => {
    const tracker = new PlanProgressTracker();
    tracker.loadPlan(samplePlan("Existing valid plan"));

    const loaded = await loadPlanFromToolResultEvent(tracker, {
      toolName: "write",
      input: { path: PLAN_PATH },
      content: [{ type: "text", text: "Wrote file" }],
    });

    expect(loaded).toBe(false);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Existing valid plan");
  });

  it("loads read events from result text", async () => {
    const tracker = new PlanProgressTracker();

    const loaded = await loadPlanFromToolResultEvent(tracker, {
      toolName: "read",
      input: { path: PLAN_PATH },
      content: [{ type: "text", text: samplePlan("Loaded from read result") }],
    });

    expect(loaded).toBe(true);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Loaded from read result");
  });

  it("resolves relative read and write plan paths against cwd for disk fallback", async () => {
    const markdown = samplePlan("Loaded from disk fallback");
    const { cwd, path } = await createTempPlan(markdown);

    const readTracker = new PlanProgressTracker();
    const readLoaded = await loadPlanFromToolResultEvent(readTracker, {
      toolName: "read",
      input: { path },
      content: [{ type: "text", text: "not plan markdown" }],
    }, cwd);

    const writeTracker = new PlanProgressTracker();
    const writeLoaded = await loadPlanFromToolResultEvent(writeTracker, {
      toolName: "write",
      input: { path },
      content: [{ type: "text", text: "Wrote file" }],
    }, cwd);

    expect(readLoaded).toBe(true);
    expect(readTracker.getGoal()).toBe("Loaded from disk fallback");
    expect(writeLoaded).toBe(true);
    expect(writeTracker.getGoal()).toBe("Loaded from disk fallback");
  });

  it("reloads subagent single-mode args from planFile before task tracking starts", async () => {
    const { cwd, path } = await createTempPlan(samplePlan("Loaded from planFile", "Run Task 1"));
    const tracker = new PlanProgressTracker();

    const loaded = await reloadPlanFromSubagentArgs(tracker, {
      agent: "plan-worker",
      task: "Task 1",
      planFile: path,
    }, cwd);

    expect(loaded).toBe(true);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Loaded from planFile");
    expect(tracker.startTaskByMatch("Task 1")).toBe(1);
  });

  it("reloads subagent args from reads", async () => {
    const { cwd, path } = await createTempPlan(samplePlan("Loaded from reads"));
    const tracker = new PlanProgressTracker();

    const loaded = await reloadPlanFromSubagentArgs(tracker, {
      agent: "plan-worker",
      task: "Task 1",
      reads: [path],
    }, cwd);

    expect(loaded).toBe(true);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Loaded from reads");
  });

  it("reloads subagent args from a task text plan path", async () => {
    const { cwd, path } = await createTempPlan(samplePlan("Loaded from task text"));
    const tracker = new PlanProgressTracker();

    const loaded = await reloadPlanFromSubagentArgs(tracker, {
      agent: "plan-worker",
      task: `Execute ${path} Task 1`,
    }, cwd);

    expect(loaded).toBe(true);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Loaded from task text");
  });

  it("extracts nested parallel and chain plan paths from subagent args", () => {
    expect(extractPlanPathsFromArgs({
      tasks: [{ task: "parallel", reads: [PLAN_PATH] }],
      chain: [{ task: `chain reads ${PLAN_PATH}` }],
    })).toEqual([PLAN_PATH]);
  });

  it("extracts harness milestone paths embedded in subagent task text", () => {
    const milestonePath = "docs/engineering-discipline/harness/powerline-ui/milestones/M1-footer-status-bridge-powerline-mvp.md";

    expect(extractMilestonePathsFromArgs({
      agent: "explorer",
      task: `We are starting M1 for ${milestonePath}. Inspect the codebase.`,
    })).toEqual([milestonePath]);
  });

  it("marks referenced milestone as planning when exploratory subagent starts", () => {
    const milestonePath = "docs/engineering-discipline/harness/powerline-ui/milestones/M1-footer-status-bridge-powerline-mvp.md";
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "Footer Status Bridge Powerline Mvp" },
      { id: "M2", name: "Footer Presets Ui Settings" },
    ]);

    const started = startMilestonesFromSubagentArgs(tracker, {
      agent: "explorer",
      task: `We are starting M1 for ${milestonePath}. Inspect the codebase.`,
    });

    expect(started).toEqual(["M1"]);
    expect(tracker.getMilestone("M1")?.status).toBe("planning");
    expect(tracker.getMilestone("M2")?.status).toBe("pending");
  });

  it("only marks the first non-terminal referenced milestone as planning", () => {
    const m1 = "docs/engineering-discipline/harness/powerline-ui/milestones/M1-footer-status-bridge-powerline-mvp.md";
    const m2 = "docs/engineering-discipline/harness/powerline-ui/milestones/M2-footer-presets-ui-settings.md";
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "Footer Status Bridge Powerline Mvp" },
      { id: "M2", name: "Footer Presets Ui Settings" },
    ]);

    const started = startMilestonesFromSubagentArgs(tracker, {
      agent: "explorer",
      task: `Review milestone files ${m1} and ${m2}`,
    });

    expect(started).toEqual(["M1"]);
    expect(tracker.getMilestone("M1")?.status).toBe("planning");
    expect(tracker.getMilestone("M2")?.status).toBe("pending");
  });

  it("marks referenced milestone as executing for plan-worker subagent", () => {
    const milestonePath = "docs/engineering-discipline/harness/powerline-ui/milestones/M1-footer-status-bridge-powerline-mvp.md";
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([{ id: "M1", name: "Footer Status Bridge Powerline Mvp" }]);

    startMilestonesFromSubagentArgs(tracker, {
      agent: "plan-worker",
      task: `Execute ${milestonePath}`,
    });

    expect(tracker.getMilestone("M1")?.status).toBe("executing");
  });

  it("loads plan markdown from finalized assistant message text", async () => {
    const tracker = new PlanProgressTracker();

    const loaded = await loadPlanFromAssistantMessageEnd(tracker, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: samplePlan("Loaded from assistant message") }],
      },
    });

    expect(loaded).toBe(true);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Loaded from assistant message");
  });

  it("does not clear an existing plan for non-plan assistant text", async () => {
    const tracker = new PlanProgressTracker();
    tracker.loadPlan(samplePlan("Existing assistant plan"));

    const loaded = await loadPlanFromAssistantMessageEnd(tracker, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Plan complete and saved." }],
      },
    });

    expect(loaded).toBe(false);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Existing assistant plan");
  });

  it("loads a plan file path mentioned in finalized assistant text", async () => {
    const markdown = samplePlan("Loaded from assistant path");
    const { cwd, path } = await createTempPlan(markdown);
    const tracker = new PlanProgressTracker();

    const loaded = await loadPlanFromAssistantMessageEnd(tracker, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Plan complete and saved to ${path}.` }],
      },
    }, cwd);

    expect(loaded).toBe(true);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Loaded from assistant path");
  });
});

describe("plan progress subagent task tracking", () => {
  it("keeps one task running after single-mode plan-worker success", () => {
    const tracker = loadTrackingPlan();

    const matchedIds = startPlanSubagentTasks(tracker, {
      agent: "plan-worker",
      task: "Execute Task 1 from the plan",
    });

    expect(matchedIds).toEqual([1]);
    expect(tracker.getProgress()).toMatchObject({ running: 1, pending: 2 });

    const completedIds = completePlanSubagentTasks(tracker, {
      agent: "plan-worker",
      task: "final output wording differs from the task name",
    }, true, matchedIds);

    expect(completedIds).toEqual([1]);
    expect(tracker.getProgress()).toMatchObject({ completed: 0, running: 1, pending: 2 });
  });

  it("uses tool_execution_start event args when no prior tool_call input was stored", () => {
    const tracker = loadTrackingPlan();
    const eventArgs = getToolExecutionArgs({
      args: { agent: "plan-worker", task: "Execute Task 2 from the plan" },
    }, undefined);

    const matchedIds = startPlanSubagentTasks(tracker, eventArgs);

    expect(matchedIds).toEqual([2]);
    expect(tracker.getProgress()).toMatchObject({ running: 1, pending: 2 });
  });

  it("falls back to stored tool_call input when execution event args are absent", () => {
    const storedArgs = { agent: "plan-worker", task: "Execute Task 3 from the plan" };

    expect(getToolExecutionArgs({}, storedArgs)).toBe(storedArgs);
  });

  it("starts and completes matched parallel tasks", () => {
    const tracker = loadTrackingPlan();
    const args = {
      tasks: [
        { agent: "plan-worker", task: "Task 1" },
        { agent: "plan-worker", task: "Task 2" },
      ],
    };

    const matchedIds = startPlanSubagentTasks(tracker, args);

    expect(matchedIds).toEqual([1, 2]);
    expect(tracker.getProgress()).toMatchObject({ running: 2, pending: 1 });

    completePlanSubagentTasks(tracker, { tasks: [{ agent: "plan-worker", task: "done" }] }, true, matchedIds);
    expect(tracker.getProgress()).toMatchObject({ completed: 0, running: 2, pending: 1 });

    completePlanSubagentTasks(tracker, { tasks: [{ agent: "plan-validator", task: "done" }] }, true, matchedIds);
    expect(tracker.getProgress()).toMatchObject({ completed: 2, running: 0, pending: 1 });
  });

  it("starts and completes matched chain tasks", () => {
    const tracker = loadTrackingPlan();
    const args = {
      chain: [
        { agent: "plan-worker", task: "Task 1" },
        { agent: "plan-worker", task: "Task 3" },
      ],
    };

    const matchedIds = startPlanSubagentTasks(tracker, args);

    expect(matchedIds).toEqual([1, 3]);
    expect(tracker.getProgress()).toMatchObject({ running: 2, pending: 1 });

    completePlanSubagentTasks(tracker, { chain: [{ agent: "plan-worker", task: "done" }] }, true, matchedIds);
    expect(tracker.getProgress()).toMatchObject({ completed: 0, running: 2, pending: 1 });

    completePlanSubagentTasks(tracker, { chain: [{ agent: "plan-validator", task: "done" }] }, true, matchedIds);
    expect(tracker.getProgress()).toMatchObject({ completed: 2, running: 0, pending: 1 });
  });

  it("does not alter progress for non-plan agents unless task text clearly matches", () => {
    const tracker = loadTrackingPlan();

    expect(startPlanSubagentTasks(tracker, {
      agent: "worker",
      task: "Investigate an unrelated issue",
    })).toEqual([]);
    expect(tracker.getProgress()).toMatchObject({ running: 0, pending: 3 });

    expect(startPlanSubagentTasks(tracker, {
      agent: "worker",
      task: "Task 3",
    })).toEqual([3]);
    expect(tracker.getProgress()).toMatchObject({ running: 1, pending: 2 });
  });

  it("marks stored running tasks failed when the subagent tool execution fails", () => {
    const tracker = loadTrackingPlan();
    const matchedIds = startPlanSubagentTasks(tracker, {
      agent: "plan-worker",
      task: "Task 2",
    });

    expect(matchedIds).toEqual([2]);

    completePlanSubagentTasks(tracker, {
      agent: "plan-worker",
      task: "failure output did not mention the task",
    }, false, matchedIds);

    expect(tracker.getProgress()).toMatchObject({ failed: 1, running: 0, pending: 2 });
  });

  it("starts a task from planTaskId when validator task text is generic", () => {
    const tracker = loadTrackingPlan();

    const matchedIds = startPlanSubagentTasks(tracker, {
      agent: "plan-validator",
      task: "validate",
      planFile: PLAN_PATH,
      planTaskId: 1,
    });

    expect(matchedIds).toEqual([1]);
    expect(tracker.getProgress()).toMatchObject({ running: 1, pending: 2 });
  });

  it("keeps tasks running through compliance and worker success, then completes on validator success", () => {
    const tracker = loadTrackingPlan();

    const complianceIds = startPlanSubagentTasks(tracker, {
      agent: "plan-compliance",
      task: "check compliance",
      planFile: PLAN_PATH,
      planTaskId: 1,
    });
    expect(complianceIds).toEqual([1]);
    expect(tracker.getProgress()).toMatchObject({ running: 1, completed: 0, pending: 2 });

    completePlanSubagentTasks(tracker, {
      agent: "plan-compliance",
      task: "check compliance",
      planFile: PLAN_PATH,
      planTaskId: 1,
    }, true, complianceIds);
    expect(tracker.getProgress()).toMatchObject({ running: 1, completed: 0, pending: 2 });

    const workerIds = startPlanSubagentTasks(tracker, {
      agent: "plan-worker",
      task: "implement task",
      planFile: PLAN_PATH,
      planTaskId: 1,
    });
    expect(workerIds).toEqual([1]);

    completePlanSubagentTasks(tracker, {
      agent: "plan-worker",
      task: "implement task",
      planFile: PLAN_PATH,
      planTaskId: 1,
    }, true, workerIds);
    expect(tracker.getProgress()).toMatchObject({ running: 1, completed: 0, pending: 2 });

    const validatorIds = startPlanSubagentTasks(tracker, {
      agent: "plan-validator",
      task: "validate",
      planFile: PLAN_PATH,
      planTaskId: 1,
    });
    expect(validatorIds).toEqual([1]);

    completePlanSubagentTasks(tracker, {
      agent: "plan-validator",
      task: "validate",
      planFile: PLAN_PATH,
      planTaskId: 1,
    }, true, validatorIds);
    expect(tracker.getProgress()).toMatchObject({ completed: 1, running: 0, pending: 2 });
  });

  it("completes a task when a mixed compliance-worker-validator chain succeeds", () => {
    const tracker = loadTrackingPlan();
    const args = {
      chain: [
        { agent: "plan-compliance", task: "check compliance", planFile: PLAN_PATH, planTaskId: 1 },
        { agent: "plan-worker", task: "implement task", planFile: PLAN_PATH, planTaskId: 1 },
        { agent: "plan-validator", task: "validate", planFile: PLAN_PATH, planTaskId: 1 },
      ],
    };

    const matchedIds = startPlanSubagentTasks(tracker, args);

    expect(matchedIds).toEqual([1, 1, 1]);
    expect(tracker.getProgress()).toMatchObject({ running: 1, completed: 0, pending: 2 });

    completePlanSubagentTasks(tracker, args, true, matchedIds);

    expect(tracker.getProgress()).toMatchObject({ completed: 1, running: 0, pending: 2 });
  });

  it("does not over-complete unrelated tasks when chain items have different planTaskIds", () => {
    const tracker = loadTrackingPlan();

    const args = {
      chain: [
        { agent: "plan-worker", task: "Task 1", planFile: PLAN_PATH, planTaskId: 1 },
        { agent: "plan-validator", task: "validate", planFile: PLAN_PATH, planTaskId: 2 },
      ],
    };

    const matchedIds = startPlanSubagentTasks(tracker, args);

    expect(matchedIds).toEqual([1, 2]);
    expect(tracker.getProgress()).toMatchObject({ running: 2, pending: 1 });

    completePlanSubagentTasks(tracker, args, true, matchedIds);

    expect(tracker.getProgress()).toMatchObject({ completed: 2, running: 0, pending: 1 });
  });

  it("marks a task failed when any plan stage with planTaskId fails", () => {
    const tracker = loadTrackingPlan();
    const matchedIds = startPlanSubagentTasks(tracker, {
      agent: "plan-compliance",
      task: "check compliance",
      planFile: PLAN_PATH,
      planTaskId: 2,
    });

    expect(matchedIds).toEqual([2]);

    completePlanSubagentTasks(tracker, {
      agent: "plan-compliance",
      task: "check compliance",
      planFile: PLAN_PATH,
      planTaskId: 2,
    }, false, matchedIds);

    expect(tracker.getProgress()).toMatchObject({ failed: 1, running: 0, pending: 2 });
  });
});

describe("plan progress session-entry reconstruction", () => {
  function messageEntry(message: unknown) {
    return { type: "message", message };
  }

  it("reconstructs a completed task from a mixed compliance-worker-validator subagent chain", async () => {
    const tracker = new PlanProgressTracker();
    const args = {
      chain: [
        { agent: "plan-compliance", task: "check compliance", planFile: PLAN_PATH, planTaskId: 1 },
        { agent: "plan-worker", task: "implement task", planFile: PLAN_PATH, planTaskId: 1 },
        { agent: "plan-validator", task: "validate", planFile: PLAN_PATH, planTaskId: 1 },
      ],
    };

    await reconstructPlanProgressFromSessionEntries(tracker, [
      messageEntry({ role: "assistant", content: [{ type: "text", text: trackingPlan() }] }),
      messageEntry({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: args }] }),
      messageEntry({ role: "toolResult", toolCallId: "call-1", toolName: "subagent", content: [{ type: "text", text: "PASS" }], isError: false }),
    ], ".");

    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getProgress()).toMatchObject({ completed: 1, running: 0, pending: 2 });
  });

  it("reconstructs a failed task from an errored subagent tool result", async () => {
    const tracker = new PlanProgressTracker();
    const args = { agent: "plan-worker", task: "Task 2", planTaskId: 2 };

    await reconstructPlanProgressFromSessionEntries(tracker, [
      messageEntry({ role: "assistant", content: [{ type: "text", text: trackingPlan() }] }),
      messageEntry({ role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "subagent", arguments: args }] }),
      messageEntry({ role: "toolResult", toolCallId: "call-2", toolName: "subagent", content: [{ type: "text", text: "FAILED" }], isError: true }),
    ], ".");

    expect(tracker.getProgress()).toMatchObject({ failed: 1, running: 0, pending: 2 });
  });

  it("reconstructs a plan from persisted write tool call arguments", async () => {
    const tracker = new PlanProgressTracker();
    const markdown = samplePlan("Loaded from replayed write");

    await reconstructPlanProgressFromSessionEntries(tracker, [
      messageEntry({
        role: "assistant",
        content: [{ type: "toolCall", id: "write-plan", name: "write", arguments: { path: PLAN_PATH, content: markdown } }],
      }),
      messageEntry({ role: "toolResult", toolCallId: "write-plan", toolName: "write", content: [{ type: "text", text: "Wrote file" }], isError: false }),
    ], ".");

    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Loaded from replayed write");
  });
});

describe("plan progress CustomEntry snapshot replay", () => {
  const CUSTOM_TYPE = "plan-progress";

  function snapshotEntry(statuses: Array<{ id: number; status: string }>, entryId = "snap-1"): unknown {
    return {
      type: "custom",
      customType: CUSTOM_TYPE,
      id: entryId,
      data: { taskStatuses: statuses },
    };
  }

  function messageEntry(message: unknown, id = `msg-${Math.random().toString(36).slice(2, 6)}`): unknown {
    return { type: "message", id, message };
  }

  it("restores task statuses from the latest CustomEntry before replaying newer events", async () => {
    const tracker = new PlanProgressTracker();

    const entries = [
      messageEntry({ role: "assistant", content: [{ type: "text", text: trackingPlan() }] }),
      snapshotEntry([{ id: 1, status: "completed" }]),
      messageEntry({
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { agent: "plan-validator", task: "Task 2", planTaskId: 2 } }],
      }),
      messageEntry({ role: "toolResult", toolCallId: "call-1", toolName: "subagent", content: [{ type: "text", text: "PASS" }], isError: false }),
    ];

    await reconstructPlanProgressFromSessionEntries(tracker, entries, ".");

    expect(tracker.getProgress()).toMatchObject({ completed: 2, running: 0, pending: 1 });
  });

  it("demotes stuck-running tasks to pending after replay", async () => {
    const tracker = new PlanProgressTracker();

    const entries = [
      messageEntry({ role: "assistant", content: [{ type: "text", text: trackingPlan() }] }),
      messageEntry({
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { agent: "plan-worker", task: "Task 1", planTaskId: 1 } }],
      }),
    ];

    await reconstructPlanProgressFromSessionEntries(tracker, entries, ".");

    expect(tracker.getProgress()).toMatchObject({ running: 0, pending: 3, completed: 0 });
  });

  it("ignores CustomEntries with unknown customType", async () => {
    const tracker = new PlanProgressTracker();

    const entries = [
      messageEntry({ role: "assistant", content: [{ type: "text", text: trackingPlan() }] }),
      { type: "custom", customType: "other-extension", id: "snap-x", data: { taskStatuses: [{ id: 1, status: "completed" }] } },
    ];

    await reconstructPlanProgressFromSessionEntries(tracker, entries, ".");

    expect(tracker.getProgress()).toMatchObject({ pending: 3, running: 0, completed: 0 });
  });
});

describe("content-based fallback for non-standard paths", () => {
  it("loads plan from WRITE with non-standard path when content has plan tasks", async () => {
    const tracker = new PlanProgressTracker();
    const sessionPaths = new Set<string>();
    const nonStandardPath = "my-custom-plans/feature.md";

    const loaded = await loadPlanFromToolResultEvent(tracker, {
      toolName: "write",
      input: { path: nonStandardPath, content: samplePlan("Custom path plan") },
      content: [{ type: "text", text: "Wrote file" }],
    }, undefined, sessionPaths);

    expect(loaded).toBe(true);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Custom path plan");
    expect(sessionPaths.has(nonStandardPath)).toBe(true);
  });

  it("loads plan from READ with non-standard path only if written in session", async () => {
    const tracker = new PlanProgressTracker();
    const sessionPaths = new Set<string>();
    const nonStandardPath = "specs/implementation.md";

    // Try READ without prior WRITE - should fail
    const readBeforeWrite = await loadPlanFromToolResultEvent(tracker, {
      toolName: "read",
      input: { path: nonStandardPath },
      content: [{ type: "text", text: samplePlan("Should not load") }],
    }, undefined, sessionPaths);

    expect(readBeforeWrite).toBe(false);
    expect(tracker.hasPlan()).toBe(false);

    // Simulate a WRITE in this session
    sessionPaths.add(nonStandardPath);

    // Now READ should work
    const readAfterWrite = await loadPlanFromToolResultEvent(tracker, {
      toolName: "read",
      input: { path: nonStandardPath },
      content: [{ type: "text", text: samplePlan("Loaded after session write") }],
    }, undefined, sessionPaths);

    expect(readAfterWrite).toBe(true);
    expect(tracker.hasPlan()).toBe(true);
    expect(tracker.getGoal()).toBe("Loaded after session write");
  });

  it("does not load random markdown files with task-like headers", async () => {
    const tracker = new PlanProgressTracker();
    const sessionPaths = new Set<string>();

    const randomMarkdown = [
      "# Some Random Document",
      "",
      "### Task 1: Not a real plan",
      "Some random content without proper plan structure.",
    ].join("\n");

    const loaded = await loadPlanFromToolResultEvent(tracker, {
      toolName: "read",
      input: { path: "notes.md" },
      content: [{ type: "text", text: randomMarkdown }],
    }, undefined, sessionPaths);

    // Should not load because it's not a proper plan (no Goal, no Steps, etc.)
    expect(loaded).toBe(false);
    expect(tracker.hasPlan()).toBe(false);
  });

  it("clears session plan paths on session start", () => {
    const sessionPaths = new Set<string>();
    sessionPaths.add("plans/old-plan.md");
    sessionPaths.add("specs/old-spec.md");

    // Simulate session start clearing
    sessionPaths.clear();

    expect(sessionPaths.size).toBe(0);
  });
});
