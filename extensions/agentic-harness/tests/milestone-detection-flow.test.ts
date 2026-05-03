import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { describe, expect, it } from "vitest";
import { MilestoneTracker, parseCompletionMd, parseStateMd } from "../milestone-tracker.js";
import { detectMilestonesFromToolResult, reconstructMilestoneProgressFromSessionEntries } from "../plan-progress-events.js";

// Exact state.md from the user's session
const USER_STATE_MD = `Long Run Status

 Progress: 3/4 milestones completed
 Next up: M4 (Tool Schema & Live Progress)

 ┌────┬─────────────────────────────┬──────────────┐
 │ ID │ Name                        │ Status       │
 ├────┼─────────────────────────────┼──────────────┤
 │ M1 │ Async Spawn Foundation      │ ✅ completed │
 ├────┼─────────────────────────────┼──────────────┤
 │ M2 │ Status Query & Interrupt    │ ✅ completed │
 ├────┼─────────────────────────────┼──────────────┤
 │ M3 │ Completion Notification     │ ✅ completed │
 ├────┼─────────────────────────────┼──────────────┤
 │ M4 │ Tool Schema & Live Progress │ ⏳ ready     │
 └────┴─────────────────────────────┴──────────────┘

 M4를 시작할까요?`;

const USER_COMPLETION_MD = `# Long Run Complete: Async Subagent Features

**Started:** 2026-05-03
**Completed:** 2026-05-03
**Total milestones:** 4
**Total attempts:** 4 (all passed on first attempt)

## Milestone Summary

| Milestone | Status | Attempts | Key Deliverable |
|-----------|--------|----------|-----------------|
| M1: Async Spawn Foundation | ✅ completed | 1 | Async spawn foundation |
| M2: Status Query & Interrupt | ✅ completed | 1 | Status and interrupt |
| M3: Completion Notification | ✅ completed | 1 | Completion notification |
| M4: Tool Schema & Live Progress | ✅ completed | 1 | Tool schema live progress |
`;

describe("Bug reproduction: full detection flow", () => {
  it("parseStateMd extracts correct milestones from user's state.md", () => {
    const parsed = parseStateMd(USER_STATE_MD);

    expect(parsed).toHaveLength(4);
    expect(parsed).toEqual([
      { id: "M1", name: "Async Spawn Foundation", status: "completed" },
      { id: "M2", name: "Status Query & Interrupt", status: "completed" },
      { id: "M3", name: "Completion Notification", status: "completed" },
      { id: "M4", name: "Tool Schema & Live Progress", status: "pending" },
    ]);
  });

  it("detectMilestonesFromToolResult loads milestones from state.md read", async () => {
    const tracker = new MilestoneTracker();

    const changed = await detectMilestonesFromToolResult(
      tracker,
      {
        toolName: "read",
        input: { path: "docs/engineering-discipline/harness/async-subagent-features/state.md" },
        content: [{ type: "text", text: USER_STATE_MD }],
      },
      "/tmp/test",
    );

    expect(changed).toBe(true);
    expect(tracker.hasMilestones()).toBe(true);
    expect(tracker.getMilestoneStatuses()).toHaveLength(4);
    expect(tracker.getMilestone("M1")?.status).toBe("completed");
    expect(tracker.getMilestone("M2")?.status).toBe("completed");
    expect(tracker.getMilestone("M3")?.status).toBe("completed");
    expect(tracker.getMilestone("M4")?.status).toBe("pending");
  });

  it("detectMilestonesFromToolResult does NOT create M5-M7", async () => {
    const tracker = new MilestoneTracker();

    await detectMilestonesFromToolResult(
      tracker,
      {
        toolName: "read",
        input: { path: "docs/engineering-discipline/harness/async-subagent-features/state.md" },
        content: [{ type: "text", text: USER_STATE_MD }],
      },
      "/tmp/test",
    );

    expect(tracker.getMilestone("M5")).toBeUndefined();
    expect(tracker.getMilestone("M6")).toBeUndefined();
    expect(tracker.getMilestone("M7")).toBeUndefined();
  });

  it("detectMilestonesFromToolResult loads milestones after state.md edit with file_path input", async () => {
    const root = await mkdtemp(join(tmpdir(), "milestone-edit-flow-"));
    try {
      const relPath = "docs/engineering-discipline/harness/async-subagent-features/state.md";
      const absPath = join(root, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, USER_STATE_MD, "utf-8");

      const tracker = new MilestoneTracker();
      const changed = await detectMilestonesFromToolResult(
        tracker,
        {
          toolName: "edit",
          input: { file_path: relPath },
          content: [{ type: "text", text: "edit diff, not full file" }],
        },
        root,
      );

      expect(changed).toBe(true);
      expect(tracker.getMilestoneStatuses()).toEqual([
        { id: "M1", status: "completed" },
        { id: "M2", status: "completed" },
        { id: "M3", status: "completed" },
        { id: "M4", status: "pending" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parseCompletionMd extracts completed milestone summary", () => {
    const parsed = parseCompletionMd(USER_COMPLETION_MD);

    expect(parsed).toEqual([
      { id: "M1", name: "Async Spawn Foundation", status: "completed" },
      { id: "M2", name: "Status Query & Interrupt", status: "completed" },
      { id: "M3", name: "Completion Notification", status: "completed" },
      { id: "M4", name: "Tool Schema & Live Progress", status: "completed" },
    ]);
  });

  it("detectMilestonesFromToolResult replaces stale milestones from completion.md write", async () => {
    const tracker = new MilestoneTracker();
    tracker.loadMilestones([
      { id: "M1", name: "old" },
      { id: "M2", name: "old" },
      { id: "M4", name: "old" },
      { id: "M5", name: "stale" },
    ]);
    tracker.setStatus("M1", "completed");
    tracker.setStatus("M2", "completed");
    tracker.setStatus("M4", "completed");
    tracker.setStatus("M5", "completed");

    const changed = await detectMilestonesFromToolResult(
      tracker,
      {
        toolName: "write",
        input: {
          path: "docs/engineering-discipline/harness/async-subagent-features/completion.md",
          content: USER_COMPLETION_MD,
        },
        content: [{ type: "text", text: "Wrote file" }],
      },
      "/tmp/test",
    );

    expect(changed).toBe(true);
    expect(tracker.getMilestoneStatuses()).toEqual([
      { id: "M1", status: "completed" },
      { id: "M2", status: "completed" },
      { id: "M3", status: "completed" },
      { id: "M4", status: "completed" },
    ]);
    expect(tracker.getMilestone("M5")).toBeUndefined();
  });

  it("reconstructs completed milestones from prior completion.md write on reload", async () => {
    const tracker = new MilestoneTracker();
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "write-completion",
              name: "write",
              arguments: {
                path: "docs/engineering-discipline/harness/async-subagent-features/completion.md",
                content: USER_COMPLETION_MD,
              },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "write-completion",
          toolName: "write",
          content: [{ type: "text", text: "Wrote completion.md" }],
        },
      },
    ];

    const result = await reconstructMilestoneProgressFromSessionEntries(tracker, entries, "/tmp/test");

    expect(result).toEqual({ changed: true, sawCompletion: true });
    expect(tracker.getMilestoneStatuses()).toEqual([
      { id: "M1", status: "completed" },
      { id: "M2", status: "completed" },
      { id: "M3", status: "completed" },
      { id: "M4", status: "completed" },
    ]);
  });

  it("render shows exactly 4 milestones with correct statuses", async () => {
    const tracker = new MilestoneTracker();
    const stubTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as any;

    await detectMilestonesFromToolResult(
      tracker,
      {
        toolName: "read",
        input: { path: "docs/engineering-discipline/harness/async-subagent-features/state.md" },
        content: [{ type: "text", text: USER_STATE_MD }],
      },
      "/tmp/test",
    );

    const lines = tracker.render(stubTheme, 200);
    const text = lines.join("\n");

    // Should show 3/4 progress
    expect(text).toContain("3/4");

    // Should show exactly M1, M2, M3, M4
    expect(text).toContain("M1");
    expect(text).toContain("M2");
    expect(text).toContain("M3");
    expect(text).toContain("M4");

    // Should NOT show M5, M6, M7
    expect(text).not.toContain("M5");
    expect(text).not.toContain("M6");
    expect(text).not.toContain("M7");
  });
});
