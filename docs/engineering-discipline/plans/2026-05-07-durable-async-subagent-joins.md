# Durable Async Subagent Joins Implementation Plan

> **Worker note:** Execute this plan task-by-task using the agentic-run-plan skill or subagents. Each step uses checkbox (`- [ ]`) syntax for progress tracking.

**Goal:** Convert async subagent wait/status from a mostly in-memory process registry into a durable, Claude-Code-inspired task lifecycle that supports cross-session result retrieval.

**Architecture:** Keep the existing `subagent` tool API compatible while making async runs durable underneath. Async spawn will create a stable run id, force a durable output artifact when none is supplied, persist run metadata on every lifecycle transition, emit structured completion notifications, and allow `action:"wait"` / `action:"status"` to read restored persisted records after session restart.

**Tech Stack:** TypeScript ESM, Vitest, Node `fs/promises`, existing agentic-harness `RunRegistry`, `runAgent()`, artifact helpers, and pi extension event hooks.

**Work Scope:**
- **In scope:** single async subagent runs, durable run records, durable output-file contract, terminal result retrieval after restart, structured completion notification, consumed/notified lifecycle, tests for registry/tool/session behavior.
- **Out of scope:** async parallel/chained runs, true process continuation after deliberate `session_shutdown` aborts, remote/tmux pane resurrection, redesigning the public `subagent` tool name, UI task panel work.

**Verification Strategy:**
- **Level:** test-suite
- **Command:** `cd extensions/agentic-harness && npm test -- tests/async-registry.test.ts tests/subagent.test.ts tests/extension.test.ts && npm run build`
- **What it validates:** durable registry behavior, async spawn artifact contract, tool wait/status behavior, structured notification/session restore wiring, and TypeScript compatibility.

---

## File Structure Mapping

- Modify `extensions/agentic-harness/types.ts`
  - Add durable async run metadata fields to `AsyncRunRecord`.
- Modify `extensions/agentic-harness/artifacts.ts`
  - Export deterministic artifact path helpers used by async spawn before `runAgent()` creates the artifact directory.
- Modify `extensions/agentic-harness/async-registry.ts`
  - Make persistence automatic, add restore/consume/notified lifecycle, remove arbitrary terminal deletion.
- Modify `extensions/agentic-harness/subagent.ts`
  - Make `spawnAsync()` use the registry run id as `runAgent()` ownership and force a default output artifact for async runs.
- Modify `extensions/agentic-harness/index.ts`
  - Use durable records in `status`/`wait`, restore persisted records on `session_start`, and emit structured notifications.
- Modify `extensions/agentic-harness/tests/async-registry.test.ts`
  - Add durable persistence/restore/consume unit tests.
- Modify `extensions/agentic-harness/tests/subagent.test.ts`
  - Add artifact helper and async spawn contract tests.
- Modify `extensions/agentic-harness/tests/extension.test.ts`
  - Add tool-level wait/status/session restore/notification tests.

## Project Capability Discovery

- Bundled subagents available: `explorer`, `planner`, `plan-compliance`, `plan-worker`, `plan-validator`, reviewers.
- Useful local verification command: `cd extensions/agentic-harness && npm test -- tests/async-registry.test.ts tests/subagent.test.ts tests/extension.test.ts && npm run build`.
- No project-specific task agent is required for this plan.

---

### Task 1: Repair pre-existing TypeScript event overload blocker

**Dependencies:** None
**Files:**
- Modify: `extensions/agentic-harness/index.ts`

- [ ] **Step 1: Make `message_end` handler compatible with the installed pi event typings**

In `extensions/agentic-harness/index.ts`, replace:

```typescript
  pi.on("message_end", async (event, ctx) => {
```

with:

```typescript
  (pi as any).on("message_end", async (event: any, ctx: any) => {
```

This preserves runtime behavior while avoiding the installed `ExtensionAPI` overload mismatch that rejects `"message_end"`.

- [ ] **Step 2: Verify the build blocker is gone**

Run:

```bash
cd extensions/agentic-harness && npm run build
```

Expected: TypeScript no longer reports `Argument of type '"message_end"' is not assignable to parameter of type '"input"'`.

---

### Task 2: Define durable async metadata and deterministic artifact path helpers

**Dependencies:** Task 1
**Files:**
- Modify: `extensions/agentic-harness/types.ts`
- Modify: `extensions/agentic-harness/artifacts.ts`
- Test: `extensions/agentic-harness/tests/subagent.test.ts`

- [ ] **Step 1: Add durable async fields to `AsyncRunRecord`**

In `extensions/agentic-harness/types.ts`, extend `AsyncRunRecord` with these optional fields immediately after `tmuxBinary?: string;`:

```typescript
  outputFile?: string;
  notified?: boolean;
  notificationSentAt?: string;
  consumedAt?: string;
  completedAt?: string;
```

- [ ] **Step 2: Export deterministic artifact path helpers**

In `extensions/agentic-harness/artifacts.ts`, replace the private `baseRunsDir`, `sanitizeSegment`, and inline run-dir logic with exported helpers while preserving existing behavior:

```typescript
export function baseRunsDir(cwd: string): string {
  return process.env.PI_SUBAGENT_ARTIFACT_ROOT || join(cwd, ".pi", "agent", "runs");
}

export function sanitizeArtifactSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

export function getArtifactRootDir(cwd: string, rootRunId: string): string {
  return resolve(baseRunsDir(cwd), sanitizeArtifactSegment(rootRunId));
}

export function getArtifactRunDir(options: Pick<ArtifactOptions, "cwd" | "rootRunId" | "runId" | "agentName">): string {
  return join(
    getArtifactRootDir(options.cwd, options.rootRunId),
    "subagents",
    `${sanitizeArtifactSegment(options.agentName)}-${sanitizeArtifactSegment(options.runId)}`,
  );
}

export function getArtifactOutputPath(options: Pick<ArtifactOptions, "cwd" | "rootRunId" | "runId" | "agentName"> & { output: string }): string {
  return resolveArtifactPath(getArtifactRunDir(options), options.output);
}
```

Then update `createArtifactContext()` to compute:

```typescript
  const rootDir = getArtifactRootDir(options.cwd, options.rootRunId);
  const runDir = getArtifactRunDir(options);
```

- [ ] **Step 3: Add artifact helper tests**

Append to `extensions/agentic-harness/tests/subagent.test.ts` imports:

```typescript
import { getArtifactOutputPath } from "../artifacts.js";
```

Add this test block near the existing constants/helper tests:

```typescript
describe("async artifact path helpers", () => {
  it("computes the same default output path shape used by subagent artifacts", () => {
    const cwd = "/tmp/project";
    const outputPath = getArtifactOutputPath({
      cwd,
      rootRunId: "run 1",
      runId: "run 1",
      agentName: "reviewer/risk",
      output: "output.md",
    });

    expect(outputPath).toBe("/tmp/project/.pi/agent/runs/run-1/subagents/reviewer-risk-run-1/output.md");
  });
});
```

- [ ] **Step 4: Verify Task 1**

Run:

```bash
cd extensions/agentic-harness && npm test -- tests/subagent.test.ts && npm run build
```

Expected: all selected tests pass and TypeScript reports no errors.

---

### Task 3: Make `RunRegistry` persist automatically and support restored terminal joins

**Dependencies:** Task 2
**Files:**
- Modify: `extensions/agentic-harness/async-registry.ts`
- Test: `extensions/agentic-harness/tests/async-registry.test.ts`

- [ ] **Step 1: Add registry constructor options and persistence tracking**

In `extensions/agentic-harness/async-registry.ts`, add this interface near `RunEntry`:

```typescript
export interface RunRegistryOptions {
  rootDir?: string;
}
```

Inside `RunRegistry`, add fields and constructor:

```typescript
  private rootDir?: string;
  private pendingPersistence = new Set<Promise<void>>();

  constructor(options: RunRegistryOptions = {}) {
    this.rootDir = options.rootDir;
  }
```

- [ ] **Step 2: Expand `update()` patch support**

Add these optional fields to the `patch` type in `update()`:

```typescript
    outputFile?: string;
    notified?: boolean;
    notificationSentAt?: string;
    consumedAt?: string;
    completedAt?: string;
```

Then apply them after tmux metadata updates:

```typescript
    if (patch.outputFile !== undefined) entry.record.outputFile = patch.outputFile;
    if (patch.notified !== undefined) entry.record.notified = patch.notified;
    if (patch.notificationSentAt !== undefined) entry.record.notificationSentAt = patch.notificationSentAt;
    if (patch.consumedAt !== undefined) entry.record.consumedAt = patch.consumedAt;
    if (patch.completedAt !== undefined) entry.record.completedAt = patch.completedAt;
```

- [ ] **Step 3: Add automatic persistence helper**

Add this private method inside `RunRegistry`:

```typescript
  private schedulePersist(runId: string): void {
    const promise = this.persist(runId, this.rootDir)
      .catch(() => undefined)
      .finally(() => this.pendingPersistence.delete(promise));
    this.pendingPersistence.add(promise);
  }

  async flushPersistence(): Promise<void> {
    await Promise.allSettled(Array.from(this.pendingPersistence));
  }
```

Call `this.schedulePersist(runId);` at the end of `register()`, `update()`, and `setDependency()` after `this.notify(...)`.

- [ ] **Step 4: Make terminal completion durable and remove 60-second deletion**

Replace `complete()` with behavior equivalent to:

```typescript
  complete(runId: string, status: "completed" | "failed" | "interrupted", result?: SingleResult): void {
    this.update(runId, {
      status,
      result,
      completedAt: new Date().toISOString(),
      outputFile: result?.artifacts?.outputFile,
    });
    this.clearKillTimer(runId);
    const entry = this.runs.get(runId);
    if (entry && this.completionNotifier && !entry.record.notified) {
      try { this.completionNotifier(entry.record); } catch { /* ignore */ }
    }
  }
```

Do not delete terminal records with `setTimeout`.

- [ ] **Step 5: Add restored record support**

Add these public methods to `RunRegistry`:

```typescript
  restore(record: AsyncRunRecord): void {
    this.runs.set(record.runId, { record });
    this.notify(record.runId, record);
  }

  async restorePersisted(rootDir = this.rootDir ?? defaultRunStateRoot()): Promise<AsyncRunRecord[]> {
    const records = await this.listPersisted(rootDir);
    for (const record of records) this.restore(record);
    return records;
  }

  markNotified(runId: string): boolean {
    const entry = this.runs.get(runId);
    if (!entry) return false;
    if (entry.record.notified) return true;
    this.update(runId, { notified: true, notificationSentAt: new Date().toISOString() });
    return true;
  }

  markConsumed(runId: string): boolean {
    const entry = this.runs.get(runId);
    if (!entry) return false;
    if (entry.record.consumedAt) return true;
    this.update(runId, { consumedAt: new Date().toISOString() });
    return true;
  }
```

- [ ] **Step 6: Make `waitForCompletion()` load persisted records when memory misses**

At the beginning of `waitForCompletion()`, replace the missing-record branch with:

```typescript
    let record = this.getStatus(runId);
    if (!record) {
      record = await this.load(runId, this.rootDir);
      if (record) this.restore(record);
    }
    if (!record) return { record: undefined, timedOut: false };
```

Change the method signature to `async waitForCompletion(...)`.

- [ ] **Step 7: Add durable registry tests**

Append these tests to `extensions/agentic-harness/tests/async-registry.test.ts`:

```typescript
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("RunRegistry durability", () => {
  it("persists records on register, update, and complete", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pi-runs-"));
    try {
      const registry = new RunRegistry({ rootDir });
      const runId = registry.register("agent", "task", "native", undefined, "needed-before-final");
      registry.update(runId, { status: "running", outputFile: "/tmp/out.md" });
      registry.complete(runId, "completed", {
        agent: "agent",
        agentSource: "unknown",
        task: "task",
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        stderr: "",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        artifacts: { outputFile: "/tmp/out.md" },
      });
      await registry.flushPersistence();

      const restored = await new RunRegistry({ rootDir }).load(runId, rootDir);
      expect(restored).toMatchObject({ runId, status: "completed", outputFile: "/tmp/out.md" });
      expect(restored?.result?.messages[0].content[0].text).toBe("done");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("waitForCompletion restores a completed persisted record", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pi-runs-"));
    try {
      const first = new RunRegistry({ rootDir });
      const runId = first.register("agent", "task", "native");
      first.complete(runId, "completed");
      await first.flushPersistence();

      const second = new RunRegistry({ rootDir });
      await expect(second.waitForCompletion(runId, 1)).resolves.toMatchObject({
        record: expect.objectContaining({ runId, status: "completed" }),
        timedOut: false,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("markNotified and markConsumed persist lifecycle flags", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pi-runs-"));
    try {
      const registry = new RunRegistry({ rootDir });
      const runId = registry.register("agent", "task", "native");
      expect(registry.markNotified(runId)).toBe(true);
      expect(registry.markConsumed(runId)).toBe(true);
      await registry.flushPersistence();

      const restored = await registry.load(runId, rootDir);
      expect(restored?.notified).toBe(true);
      expect(restored?.notificationSentAt).toBeTruthy();
      expect(restored?.consumedAt).toBeTruthy();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 8: Verify Task 2**

Run:

```bash
cd extensions/agentic-harness && npm test -- tests/async-registry.test.ts && npm run build
```

Expected: all selected tests pass and TypeScript reports no errors.

---

### Task 4: Wire async spawn to durable output artifacts and stable ownership

**Dependencies:** Task 3
**Files:**
- Modify: `extensions/agentic-harness/subagent.ts`
- Test: `extensions/agentic-harness/tests/subagent.test.ts`

- [ ] **Step 1: Import artifact output helper**

Change the `artifacts.js` import in `extensions/agentic-harness/subagent.ts` to include `getArtifactOutputPath`:

```typescript
import { createArtifactContext, getArtifactOutputPath, readDeclaredFiles, readFilePrefix, type ArtifactContext } from "./artifacts.js";
```

- [ ] **Step 2: Force a default async output artifact**

Inside `spawnAsync()`, after `const runId = registry.register(...)`, add:

```typescript
  const asyncOutput = opts.output ?? opts.agent?.output ?? "output.md";
  const outputFile = getArtifactOutputPath({
    cwd: opts.cwd,
    rootRunId: runId,
    runId,
    agentName: opts.agentName,
    output: asyncOutput,
  });
  registry.update(runId, { outputFile });
```

- [ ] **Step 3: Use registry run id as subagent ownership**

In `mergedOpts`, add these fields before `signal`:

```typescript
      output: asyncOutput,
      ownership: {
        runId,
        rootRunId: runId,
        owner: opts.agentName,
      },
```

This ensures `runAgent()` writes artifacts under the same run id returned to the parent.

- [ ] **Step 4: Preserve output file on completion**

In `spawnAsync()` completion, keep the existing `registry.complete(...)` call. Task 3 makes `complete()` copy `result.artifacts.outputFile` into the persisted record.

- [ ] **Step 5: Add async spawn source-level contract test**

In `extensions/agentic-harness/tests/subagent.test.ts`, add this source-level contract test so verification does not launch a real pi child:

```typescript
import { readFileSync } from "fs";

describe("spawnAsync durable contract", () => {
  it("passes durable ownership and default output to runAgent", () => {
    const source = readFileSync(new URL("../subagent.ts", import.meta.url), "utf8");
    expect(source).toContain("asyncOutput");
    expect(source).toContain("output.md");
    expect(source).toContain("getArtifactOutputPath");
    expect(source).toContain("rootRunId: runId");
    expect(source).toContain("owner: opts.agentName");
    expect(source).toContain("registry.update(runId, { outputFile })");
  });
});
```

- [ ] **Step 6: Verify Task 3**

Run:

```bash
cd extensions/agentic-harness && npm test -- tests/subagent.test.ts tests/async-registry.test.ts && npm run build
```

Expected: all selected tests pass and TypeScript reports no errors.

---

### Task 5: Wire durable wait/status/session restore and structured notifications in the tool surface

**Dependencies:** Task 4
**Files:**
- Modify: `extensions/agentic-harness/index.ts`
- Test: `extensions/agentic-harness/tests/extension.test.ts`

- [ ] **Step 1: Include output file in status rendering**

In the `params.action === "status"` branch for a specific id, add this line after `Backend: ${record.backend}`:

```typescript
                record.outputFile ? `Output file: ${record.outputFile}` : null,
```

- [ ] **Step 2: Mark successful waits as consumed**

In the `params.action === "wait"` branch, after a terminal record with a captured result is retrieved and before returning success, call:

```typescript
            registry.markConsumed(record.runId);
```

For terminal records with no captured result, call `registry.markConsumed(record.runId);` before returning the "finished with status" message.

Do not mark a run consumed on timeout.

- [ ] **Step 3: Restore persisted async runs on session start**

At the beginning of the `pi.on("session_start", async (_event, ctx) => { ... })` handler, after clearing trackers and before reading branch entries, add:

```typescript
    await getDefaultRegistry().restorePersisted(join(ctx.cwd, ".pi", "agent", "runs"));
```

`join` is already imported from `path`; if not present in the import list, add it.

- [ ] **Step 4: Emit structured completion notifications**

Replace the current `registry.setCompletionNotifier((record) => { ... })` body with a structured message that marks notification once:

```typescript
  registry.setCompletionNotifier((record) => {
    if (!registry.markNotified(record.runId)) return;
    const statusEmoji = record.status === "completed" ? "✅" : record.status === "failed" ? "❌" : "⚠️";
    const summary = record.result
      ? `Exit code: ${record.result.exitCode}`
      : `Status: ${record.status}`;
    const elapsed = Math.round(record.progress.elapsedMs / 1000);
    const outputFile = record.outputFile || record.result?.artifacts?.outputFile;
    const resultText = record.result ? getResultSummaryText(record.result, record.result.maxOutput) : "";
    const usage = record.result?.usage ?? record.progress.usage;
    pi.sendUserMessage(
      `<async-subagent-notification>\n` +
      `<run_id>${record.runId}</run_id>\n` +
      `<agent>${record.agent}</agent>\n` +
      `<status>${record.status}</status>\n` +
      `<summary>${statusEmoji} Async subagent completed: ${record.agent} — ${summary} | ${elapsed}s</summary>\n` +
      (outputFile ? `<output_file>${outputFile}</output_file>\n` : "") +
      (resultText ? `<result>${resultText}</result>\n` : "") +
      `<usage><input>${usage.input}</input><output>${usage.output}</output><turns>${usage.turns}</turns></usage>\n` +
      `</async-subagent-notification>`,
      { deliverAs: "followUp" },
    );
  });
```

- [ ] **Step 5: Update prompt guidance to mention durable output files**

In the `subagent` tool `promptGuidelines`, update the async guidance line so it includes: `Async starts return a run id and durable output file path when available; use action:'wait' to join rather than guessing.`

- [ ] **Step 6: Add extension tests**

In `extensions/agentic-harness/tests/extension.test.ts`, extend the existing async tests with:

```typescript
it("status includes durable output file when present", async () => {
  const { mockPi, tools } = createMockPi();
  extension(mockPi);
  const subagentTool = tools.get("subagent");
  const registry = getDefaultRegistry();
  const runId = registry.register("explorer", "inspect issue", "native", undefined, "needed-before-final");
  registry.update(runId, { status: "running", outputFile: "/tmp/pi-run/output.md" });

  const result = await subagentTool.execute(
    "status-call",
    { action: "status", id: runId },
    undefined,
    undefined,
    { cwd: process.cwd(), hasUI: false, ui: {} },
  );

  expect(result.content[0].text).toContain("Output file: /tmp/pi-run/output.md");
  registry.complete(runId, "interrupted");
});

it("wait marks terminal runs consumed", async () => {
  const { mockPi, tools } = createMockPi();
  extension(mockPi);
  const subagentTool = tools.get("subagent");
  const registry = getDefaultRegistry();
  const runId = registry.register("explorer", "inspect issue", "native", undefined, "needed-before-final");
  registry.complete(runId, "completed", {
    agent: "explorer",
    agentSource: "bundled",
    task: "inspect issue",
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    stderr: "",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
  });

  await subagentTool.execute("wait-call", { action: "wait", id: runId }, undefined, undefined, { cwd: process.cwd(), hasUI: false, ui: {} });
  expect(registry.getStatus(runId)?.consumedAt).toBeTruthy();
});

it("completion notification is structured and marks run notified", () => {
  const { mockPi } = createMockPi();
  extension(mockPi);
  const registry = getDefaultRegistry();
  const runId = registry.register("explorer", "inspect issue", "native", undefined, "needed-before-final");
  registry.complete(runId, "completed", {
    agent: "explorer",
    agentSource: "bundled",
    task: "inspect issue",
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    stderr: "",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
    artifacts: { outputFile: "/tmp/pi-run/output.md" },
  });

  expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
    expect.stringContaining("<async-subagent-notification>"),
    { deliverAs: "followUp" },
  );
  expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
    expect.stringContaining("<output_file>/tmp/pi-run/output.md</output_file>"),
    { deliverAs: "followUp" },
  );
  expect(registry.getStatus(runId)?.notified).toBe(true);
});
```

- [ ] **Step 7: Verify Task 4**

Run:

```bash
cd extensions/agentic-harness && npm test -- tests/extension.test.ts tests/async-registry.test.ts && npm run build
```

Expected: all selected tests pass and TypeScript reports no errors.

---

### Task 6 (Final): Full verification and self-review

**Dependencies:** Tasks 1-5
**Files:** None (read-only verification)

- [ ] **Step 1: Run targeted high-signal verification**

Run:

```bash
cd extensions/agentic-harness && npm test -- tests/async-registry.test.ts tests/subagent.test.ts tests/extension.test.ts && npm run build
```

Expected: all selected tests pass and TypeScript reports no errors.

- [ ] **Step 2: Run full agentic-harness test suite**

Run:

```bash
cd extensions/agentic-harness && npm test
```

Expected: all tests pass. If an unrelated pre-existing flaky tmux/process test fails, rerun the exact failing test once and record the command/output in the completion report.

- [ ] **Step 3: Verify success criteria manually**

Check each item:

- [ ] Async spawn returns a run id and durable output file path is recorded in the run record.
- [ ] `action:"status"` can show the durable output file for a run.
- [ ] `action:"wait"` can retrieve a completed persisted run after memory restore.
- [ ] Terminal records are not deleted after an arbitrary 60 seconds.
- [ ] `wait` timeout does not mark a run consumed.
- [ ] Successful terminal `wait` marks the run consumed.
- [ ] Completion notification includes structured tags, run id, status, output file, result/summary, and usage.
- [ ] Session start calls registry restore for persisted async records.

- [ ] **Step 4: Report completion**

Summarize changed files, test commands, and any intentionally deferred scope: async parallel/chained runs, remote process resurrection, UI task panel.

---

## Self-Review

- **Spec coverage:** The plan covers durable metadata, output-file contract, cross-session terminal joins, structured notifications, consumed/notified lifecycle, and tests.
- **Placeholder scan:** No `TBD`, `TODO`, or unspecified implementation placeholders remain.
- **Type consistency:** New fields are added to `AsyncRunRecord` and used consistently as `outputFile`, `notified`, `notificationSentAt`, `consumedAt`, and `completedAt`.
- **Dependency verification:** Tasks are sequential because they modify overlapping files and later tasks depend on earlier type/helper changes.
- **Verification coverage:** Final verification uses the project test suite plus build.
