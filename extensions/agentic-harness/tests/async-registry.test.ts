import { describe, it, expect, vi } from "vitest";
import { RunRegistry, getDefaultRegistry } from "../async-registry.js";
import type { SingleResult } from "../types.js";

describe("RunRegistry", () => {
  it("register creates entry with status spawning", () => {
    const registry = new RunRegistry();
    const runId = registry.register("test-agent", "test task", "native");

    expect(runId).toBeTruthy();
    expect(runId.length).toBe(16); // randomBytes(8).toString("hex")

    const record = registry.getStatus(runId);
    expect(record).toBeDefined();
    expect(record!.status).toBe("spawning");
    expect(record!.agent).toBe("test-agent");
    expect(record!.task).toBe("test task");
    expect(record!.backend).toBe("native");
    expect(record!.progress.elapsedMs).toBe(0);
    expect(record!.progress.usage.input).toBe(0);
  });

  it("register records async dependency when provided", () => {
    const registry = new RunRegistry();
    const runId = registry.register("test-agent", "test task", "native", undefined, "needed-before-final");

    expect(registry.getStatus(runId)!.dependency).toBe("needed-before-final");
  });

  it("update changes status and pid", () => {
    const registry = new RunRegistry();
    const runId = registry.register("agent", "task", "native");

    registry.update(runId, { status: "running", pid: 12345 });

    const record = registry.getStatus(runId);
    expect(record!.status).toBe("running");
    expect(record!.pid).toBe(12345);
  });

  it("update merges progress", () => {
    const registry = new RunRegistry();
    const runId = registry.register("agent", "task", "native");

    registry.update(runId, {
      progress: {
        lastActivity: { name: "bash", args: {}, timestamp: Date.now() },
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 150, turns: 1 },
      },
    });

    const record = registry.getStatus(runId);
    expect(record!.progress.lastActivity?.name).toBe("bash");
    expect(record!.progress.usage.input).toBe(100);
    expect(record!.progress.usage.output).toBe(50);
  });

  it("complete sets terminal status", () => {
    const registry = new RunRegistry();
    const runId = registry.register("agent", "task", "native");

    registry.complete(runId, "completed");

    const record = registry.getStatus(runId);
    expect(record!.status).toBe("completed");
  });

  it("complete with result stores result", () => {
    const registry = new RunRegistry();
    const runId = registry.register("agent", "task", "native");

    const mockResult = {
      agent: "agent",
      agentSource: "unknown" as const,
      task: "task",
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    };

    registry.complete(runId, "completed", mockResult);

    const record = registry.getStatus(runId);
    expect(record!.result).toBe(mockResult);
  });

  it("listActive returns all tracked runs including recently completed", () => {
    const registry = new RunRegistry();
    const id1 = registry.register("agent1", "task1", "native");
    const id2 = registry.register("agent2", "task2", "tmux");
    registry.complete(id1, "completed");

    const active = registry.listActive();
    // complete() uses lazy cleanup (setTimeout 60s), so entry is still in map
    expect(active.length).toBe(2);
    expect(active.find(r => r.runId === id1)!.status).toBe("completed");
    expect(active.find(r => r.runId === id2)!.status).toBe("spawning");
  });

  it("abort triggers AbortController", () => {
    const registry = new RunRegistry();
    const controller = new AbortController();
    const runId = registry.register("agent", "task", "native", controller);

    expect(controller.signal.aborted).toBe(false);
    registry.abort(runId);
    expect(controller.signal.aborted).toBe(true);
  });

  it("abort returns false for unknown runId", () => {
    const registry = new RunRegistry();
    expect(registry.abort("nonexistent")).toBe(false);
  });

  it("subscribe receives notifications", () => {
    const registry = new RunRegistry();
    const events: Array<{ runId: string; status: string }> = [];

    registry.subscribe((runId, record) => {
      events.push({ runId, status: record.status });
    });

    const runId = registry.register("agent", "task", "native");
    registry.update(runId, { status: "running" });
    registry.complete(runId, "completed");

    // register emits "spawning", update emits "running", complete emits "completed"
    expect(events.length).toBe(3);
    expect(events[0]).toEqual({ runId, status: "spawning" });
    expect(events[1]).toEqual({ runId, status: "running" });
    expect(events[2]).toEqual({ runId, status: "completed" });
  });

  it("unsubscribe stops notifications", () => {
    const registry = new RunRegistry();
    const events: string[] = [];

    const unsub = registry.subscribe((_runId, record) => {
      events.push(record.status);
    });

    registry.register("agent", "task", "native");
    expect(events.length).toBe(1);

    unsub();
    registry.register("agent2", "task2", "native");
    expect(events.length).toBe(1); // no new events
  });

  it("getStatus returns undefined for unknown runId", () => {
    const registry = new RunRegistry();
    expect(registry.getStatus("nonexistent")).toBeUndefined();
  });

  it("waitForCompletion resolves immediately for completed runs", async () => {
    const registry = new RunRegistry();
    const runId = registry.register("agent", "task", "native");
    registry.complete(runId, "completed");

    await expect(registry.waitForCompletion(runId)).resolves.toMatchObject({
      record: expect.objectContaining({ runId, status: "completed" }),
      timedOut: false,
    });
  });

  it("waitForCompletion resolves when a running async run completes", async () => {
    const registry = new RunRegistry();
    const runId = registry.register("agent", "task", "native");

    const wait = registry.waitForCompletion(runId, 1000);
    registry.complete(runId, "completed");

    await expect(wait).resolves.toMatchObject({
      record: expect.objectContaining({ runId, status: "completed" }),
      timedOut: false,
    });
  });

  it("waitForCompletion times out with the current record", async () => {
    const registry = new RunRegistry();
    const runId = registry.register("agent", "task", "native");

    await expect(registry.waitForCompletion(runId, 1)).resolves.toMatchObject({
      record: expect.objectContaining({ runId, status: "spawning" }),
      timedOut: true,
    });
  });

  it("update is no-op for unknown runId", () => {
    const registry = new RunRegistry();
    // Should not throw
    registry.update("nonexistent", { status: "running" });
    expect(registry.getStatus("nonexistent")).toBeUndefined();
  });

  it("tmux backend is recorded", () => {
    const registry = new RunRegistry();
    const runId = registry.register("agent", "task", "tmux");

    const record = registry.getStatus(runId);
    expect(record!.backend).toBe("tmux");
  });

  it("multiple concurrent runs are tracked independently", () => {
    const registry = new RunRegistry();
    const id1 = registry.register("agent1", "task1", "native");
    const id2 = registry.register("agent2", "task2", "native");

    registry.update(id1, { status: "running", pid: 100 });
    registry.update(id2, { status: "running", pid: 200 });

    expect(registry.getStatus(id1)!.pid).toBe(100);
    expect(registry.getStatus(id2)!.pid).toBe(200);

    registry.complete(id1, "completed");
    expect(registry.getStatus(id1)!.status).toBe("completed");
    expect(registry.getStatus(id2)!.status).toBe("running");
  });
});

describe("getDefaultRegistry", () => {
  it("returns the same instance on multiple calls", () => {
    const r1 = getDefaultRegistry();
    const r2 = getDefaultRegistry();
    expect(r1).toBe(r2);
  });
});

describe("completionNotifier", () => {
  it("fires when a run completes", () => {
    const registry = new RunRegistry();
    const notified: string[] = [];
    registry.setCompletionNotifier((record) => {
      notified.push(`${record.runId}:${record.status}`);
    });

    const runId = registry.register("agent", "task", "native");
    expect(notified.length).toBe(0); // register does not trigger

    registry.complete(runId, "completed");
    expect(notified.length).toBe(1);
    expect(notified[0]).toBe(`${runId}:completed`);
  });

  it("fires on failed runs too", () => {
    const registry = new RunRegistry();
    const notified: string[] = [];
    registry.setCompletionNotifier((record) => {
      notified.push(record.status);
    });

    const runId = registry.register("agent", "task", "native");
    registry.complete(runId, "failed");
    expect(notified).toEqual(["failed"]);
  });

  it("does not fire on update", () => {
    const registry = new RunRegistry();
    let count = 0;
    registry.setCompletionNotifier(() => { count++; });

    const runId = registry.register("agent", "task", "native");
    registry.update(runId, { status: "running" });
    expect(count).toBe(0);
  });
});

describe("full async lifecycle", () => {
  it("register → update(progress) → complete with result", () => {
    const registry = new RunRegistry();
    const lifecycle: string[] = [];

    registry.subscribe((_id, record) => {
      lifecycle.push(record.status);
    });

    // 1. Register
    const runId = registry.register("reviewer", "review this diff", "native");
    expect(registry.getStatus(runId)!.status).toBe("spawning");

    // 2. Spawned (pid available)
    registry.update(runId, { pid: 12345, status: "running" });
    expect(registry.getStatus(runId)!.pid).toBe(12345);
    expect(registry.getStatus(runId)!.status).toBe("running");

    // 3. Progress update (tool activity)
    registry.update(runId, {
      progress: {
        lastActivity: { name: "bash", args: { command: "npm test" }, timestamp: Date.now() },
        usage: { input: 500, output: 200, cacheRead: 100, cacheWrite: 0, cost: 0.02, contextTokens: 800, turns: 3 },
      },
    });
    const afterProgress = registry.getStatus(runId)!;
    expect(afterProgress.progress.lastActivity?.name).toBe("bash");
    expect(afterProgress.progress.usage.input).toBe(500);

    // 4. Complete with result
    const mockResult: SingleResult = {
      agent: "reviewer",
      agentSource: "user",
      task: "review this diff",
      exitCode: 0,
      messages: [{ role: "assistant", content: [{ type: "text", text: "Looks good" }] }],
      stderr: "",
      usage: { input: 500, output: 200, cacheRead: 100, cacheWrite: 0, cost: 0.02, contextTokens: 800, turns: 3 },
    };
    registry.complete(runId, "completed", mockResult);
    const final = registry.getStatus(runId)!;
    expect(final.status).toBe("completed");
    expect(final.result).toBe(mockResult);
    expect(final.progress.elapsedMs).toBeGreaterThanOrEqual(0);

    // 5. Verify lifecycle events
    expect(lifecycle).toEqual(["spawning", "running", "running", "completed"]);
  });

  it("interrupt lifecycle: running → aborted via controller", () => {
    const registry = new RunRegistry();
    const controller = new AbortController();
    const runId = registry.register("worker", "implement feature", "native", controller);
    registry.update(runId, { status: "running" });

    // Interrupt via abort controller (no real PID needed)
    const success = registry.abort(runId);
    expect(success).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });
});
