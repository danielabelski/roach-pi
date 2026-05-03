# pi v0.72 Non-Team Adoption Implementation Plan

> **Worker note:** Execute this plan task-by-task using the agentic-run-plan skill or subagents. Each step uses checkbox (`- [ ]`) syntax for progress tracking.

**Goal:** Adopt useful pi-mono v0.70-v0.72 updates in this extension suite while explicitly excluding team-mode and `thinking_level_select` UI work.

**Architecture:** Upgrade the extension packages to pi `0.72.1`, then add two small harness integrations around finalized assistant messages and working-row visibility. Keep runtime behavior provider-agnostic; document `thinkingLevelMap` compatibility and the `shouldStopAfterTurn` feasibility boundary instead of adding provider or low-level agent-core code the extension API cannot support.

**Tech Stack:** TypeScript ES modules, pi ExtensionAPI, Vitest, npm package-locks, Markdown docs.

**Work Scope:**
- **In scope:** pin direct pi package dependencies to `^0.72.1`; enhance agentic-harness `message_end` handling to load finalized assistant plan markdown/path references into the plan-progress footer; hide pi's built-in working loader only while harness plan-progress tasks are running; document pi v0.72 provider compatibility (`thinkingLevelMap`) and why `shouldStopAfterTurn` is not extension-implementable today.
- **Out of scope:** team mode changes; `thinking_level_select` event/UI integration; custom provider registration; built-in provider additions such as Xiaomi MiMo, Cloudflare, Moonshot, DeepSeek, or Mistral; self-update behavior; changing the subagent/team orchestration model.

**Verification Strategy:**
- **Level:** e2e/test-suite
- **Command:** `for dir in extensions/agentic-harness extensions/session-loop extensions/autonomous-dev extensions/fff-search extensions/workspace-memory; do (cd "$dir" && npm test && npm run build) || exit 1; done && git diff --check`
- **What it validates:** All extension package unit/integration/e2e-style Vitest suites still pass against pi `0.72.1`, TypeScript accepts the new API usage, and generated diffs contain no whitespace errors.

**Project Capability Discovery:**
- Bundled subagents available: `explorer`, `worker`, `planner`, `plan-compliance`, `plan-worker`, `plan-validator`, reviewers, and synthesis agents.
- Useful project skills available: `agentic-run-plan`, `agentic-systematic-debugging`, `agentic-simplify`, `agentic-review-work`.
- No project-specific `.agents/` or `.pi/agents/` worker required for this plan; use normal plan-worker/validator flow.

---

## File Structure Mapping

- `extensions/agentic-harness/package.json` — pin direct pi runtime packages to `^0.72.1`.
- `extensions/autonomous-dev/package.json` — pin direct pi runtime packages to `^0.72.1`.
- `extensions/fff-search/package.json` — pin direct pi runtime packages to `^0.72.1`.
- `extensions/session-loop/package.json` — pin direct pi runtime packages to `^0.72.1`.
- `extensions/workspace-memory/package.json` — pin direct pi runtime packages to `^0.72.1`.
- `package-lock.json` and `extensions/*/package-lock.json` — refresh lockfiles after package pinning.
- `extensions/agentic-harness/plan-progress-events.ts` — add finalized assistant-message plan loading helpers.
- `extensions/agentic-harness/tests/plan-progress-events.test.ts` — test assistant-message plan loading behavior.
- `extensions/agentic-harness/index.ts` — call the new message-end plan loader and wire the working-visibility controller.
- `extensions/agentic-harness/working-visibility.ts` — new focused helper for safe `ctx.ui.setWorkingVisible()` toggling.
- `extensions/agentic-harness/tests/working-visibility.test.ts` — unit tests for the working-row visibility helper.
- `extensions/agentic-harness/README.md` — document v0.72 compatibility and exclusions.
- `extensions/session-loop/README.md` — document the `shouldStopAfterTurn` ExtensionAPI boundary.

---

### Task 1: Pin pi runtime dependencies to v0.72.1

**Dependencies:** None (can run in parallel with Task 4, but run before Tasks 2-3 for type availability)
**Files:**
- Modify: `extensions/agentic-harness/package.json`
- Modify: `extensions/autonomous-dev/package.json`
- Modify: `extensions/fff-search/package.json`
- Modify: `extensions/session-loop/package.json`
- Modify: `extensions/workspace-memory/package.json`
- Modify: `package-lock.json`
- Modify: `extensions/agentic-harness/package-lock.json`
- Modify: `extensions/autonomous-dev/package-lock.json`
- Modify: `extensions/fff-search/package-lock.json`
- Modify: `extensions/session-loop/package-lock.json`
- Modify: `extensions/workspace-memory/package-lock.json`

- [ ] **Step 1: Update direct pi dependency ranges**

Run this from the repository root:

```bash
node - <<'NODE'
const fs = require('node:fs');
const paths = [
  'extensions/agentic-harness/package.json',
  'extensions/autonomous-dev/package.json',
  'extensions/fff-search/package.json',
  'extensions/session-loop/package.json',
  'extensions/workspace-memory/package.json',
];
for (const path of paths) {
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  pkg.dependencies ??= {};
  if (pkg.dependencies['@mariozechner/pi-coding-agent']) {
    pkg.dependencies['@mariozechner/pi-coding-agent'] = '^0.72.1';
  }
  if (pkg.dependencies['@mariozechner/pi-tui']) {
    pkg.dependencies['@mariozechner/pi-tui'] = '^0.72.1';
  }
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}
NODE
```

Expected: the five extension package manifests no longer contain `"latest"` or `"^0.70.2"` for `@mariozechner/pi-coding-agent`/`@mariozechner/pi-tui`.

- [ ] **Step 2: Refresh package lockfiles without installing packages globally**

Run:

```bash
npm install --package-lock-only
for dir in extensions/agentic-harness extensions/autonomous-dev extensions/fff-search extensions/session-loop extensions/workspace-memory; do
  (cd "$dir" && npm install --package-lock-only) || exit 1
done
```

Expected: all relevant package-lock files resolve `@mariozechner/pi-coding-agent` to a `0.72.1` compatible version and `@mariozechner/pi-tui` to a `0.72.1` compatible version where used.

- [ ] **Step 3: Run dependency-focused build checks**

Run:

```bash
for dir in extensions/agentic-harness extensions/autonomous-dev extensions/fff-search extensions/session-loop extensions/workspace-memory; do
  (cd "$dir" && npm run build) || exit 1
done
```

Expected: all TypeScript builds pass. If the build exposes upstream API type differences, fix only the direct type errors needed to compile against pi `0.72.1`.

- [ ] **Step 4: Commit**

```bash
git add package-lock.json extensions/*/package.json extensions/*/package-lock.json
git commit -m "chore: pin pi extension dependencies to v0.72"
```

---

### Task 2: Load plan progress from finalized assistant messages

**Dependencies:** Runs after Task 1 completes
**Files:**
- Modify: `extensions/agentic-harness/plan-progress-events.ts`
- Modify: `extensions/agentic-harness/tests/plan-progress-events.test.ts`
- Modify: `extensions/agentic-harness/index.ts`

- [ ] **Step 1: Add assistant message text/path extraction helpers**

In `extensions/agentic-harness/plan-progress-events.ts`, add the following helper code after `extractToolResultText` and before `getToolExecutionArgs`:

```ts
function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;

  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

export async function loadPlanFromAssistantMessageEnd(
  tracker: PlanProgressTracker,
  event: unknown,
  cwd?: string,
  sessionPlanPaths?: Set<string>,
): Promise<boolean> {
  if (!event || typeof event !== "object") return false;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return false;
  if ((message as { role?: unknown }).role !== "assistant") return false;

  const text = extractMessageText(message);
  if (!text) return false;

  if (await loadPlanFromTextOrFile(tracker, { text, cwd })) {
    return true;
  }

  for (const planPath of extractPlanPathsFromArgs({ task: text })) {
    if (sessionPlanPaths) sessionPlanPaths.add(planPath);
    if (await loadPlanFromTextOrFile(tracker, { path: planPath, cwd })) {
      return true;
    }
  }

  return false;
}
```

Expected: non-assistant messages return `false`; assistant text that contains a parseable plan loads into the tracker; assistant text that only contains a known plan path loads from disk.

- [ ] **Step 2: Add unit tests for finalized assistant message loading**

Append these tests inside the existing `describe("plan progress event loading", () => { ... })` block in `extensions/agentic-harness/tests/plan-progress-events.test.ts`. Also update the import list at the top to include `loadPlanFromAssistantMessageEnd`.

```ts
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
```

- [ ] **Step 3: Wire the helper into the existing `message_end` handler**

In `extensions/agentic-harness/index.ts`, update the import from `./plan-progress-events.js` to include `loadPlanFromAssistantMessageEnd`:

```ts
import {
  completePlanSubagentTasks,
  getToolExecutionArgs,
  loadPlanFromAssistantMessageEnd,
  loadPlanFromToolResultEvent,
  reloadPlanFromSubagentArgs,
  startPlanSubagentTasks,
} from "./plan-progress-events.js";
```

Then replace the existing `message_end` handler near the end of the file with:

```ts
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role === "assistant") {
      const usage = msg.usage;
      if (usage) {
        cacheStats.totalInput += usage.input;
        cacheStats.totalCacheRead += usage.cacheRead;
      }
    }

    await loadPlanFromAssistantMessageEnd(planProgress, event, ctx.cwd, sessionPlanPaths);
  });
```

Expected: existing cache stats behavior remains unchanged, no `{ message }` replacement is returned, and plan-progress can initialize from finalized assistant plan content.

- [ ] **Step 4: Run focused tests**

Run:

```bash
cd extensions/agentic-harness
npm test -- --run tests/plan-progress-events.test.ts
npm run build
```

Expected: focused tests and type-check pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/agentic-harness/plan-progress-events.ts extensions/agentic-harness/tests/plan-progress-events.test.ts extensions/agentic-harness/index.ts
git commit -m "feat: load plan progress from finalized assistant messages"
```

---

### Task 3: Hide the built-in working row while plan tasks run

**Dependencies:** Runs after Task 2 completes
**Files:**
- Create: `extensions/agentic-harness/working-visibility.ts`
- Create: `extensions/agentic-harness/tests/working-visibility.test.ts`
- Modify: `extensions/agentic-harness/index.ts`

- [ ] **Step 1: Create a focused working visibility controller**

Create `extensions/agentic-harness/working-visibility.ts` with this content:

```ts
import type { PlanProgressTracker } from "./plan-progress.js";

type WorkingVisibilityUi = {
  setWorkingVisible?: (visible: boolean) => void;
};

export class WorkingVisibilityController {
  private unsubscribe: (() => void) | null = null;
  private hidden = false;

  constructor(
    private readonly planProgress: PlanProgressTracker,
    private readonly ui: WorkingVisibilityUi,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.planProgress.subscribeOnChange(() => this.sync());
    this.sync();
  }

  sync(): void {
    if (!this.ui.setWorkingVisible) return;

    const shouldHide = this.planProgress.hasPlan()
      && this.planProgress.getProgress().running > 0;

    if (shouldHide === this.hidden) return;
    this.hidden = shouldHide;
    this.ui.setWorkingVisible(!shouldHide);
  }

  restore(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (this.hidden) {
      this.ui.setWorkingVisible?.(true);
    }
    this.hidden = false;
  }
}
```

- [ ] **Step 2: Add unit tests for visibility toggling and restoration**

Create `extensions/agentic-harness/tests/working-visibility.test.ts` with this content:

```ts
import { describe, expect, it, vi } from "vitest";
import { PlanProgressTracker } from "../plan-progress.js";
import { WorkingVisibilityController } from "../working-visibility.js";

function samplePlan(): string {
  return [
    "# Visibility Plan",
    "",
    "**Goal:** Toggle working row only while plan work runs",
    "",
    "---",
    "",
    "### Task 1: Run visible task",
    "",
    "**Dependencies:** None",
    "**Files:**",
    "- Modify: `extensions/agentic-harness/index.ts`",
    "",
    "- [ ] **Step 1: Execute**",
    "",
    "Run: `npm test`",
    "Expected: pass",
    "",
  ].join("\n");
}

describe("WorkingVisibilityController", () => {
  it("hides the built-in working row only while a plan task is running", () => {
    const tracker = new PlanProgressTracker();
    tracker.loadPlan(samplePlan());
    const setWorkingVisible = vi.fn();
    const controller = new WorkingVisibilityController(tracker, { setWorkingVisible });

    controller.start();
    expect(setWorkingVisible).not.toHaveBeenCalled();

    tracker.startTask(1);
    expect(setWorkingVisible).toHaveBeenLastCalledWith(false);

    tracker.completeTask(1, true);
    expect(setWorkingVisible).toHaveBeenLastCalledWith(true);
  });

  it("restores visibility on shutdown when currently hidden", () => {
    const tracker = new PlanProgressTracker();
    tracker.loadPlan(samplePlan());
    const setWorkingVisible = vi.fn();
    const controller = new WorkingVisibilityController(tracker, { setWorkingVisible });

    controller.start();
    tracker.startTask(1);
    controller.restore();

    expect(setWorkingVisible).toHaveBeenLastCalledWith(true);
  });

  it("is a no-op on older UI objects without setWorkingVisible", () => {
    const tracker = new PlanProgressTracker();
    tracker.loadPlan(samplePlan());
    const controller = new WorkingVisibilityController(tracker, {});

    expect(() => {
      controller.start();
      tracker.startTask(1);
      controller.restore();
    }).not.toThrow();
  });
});
```

- [ ] **Step 3: Wire the controller into harness session lifecycle**

In `extensions/agentic-harness/index.ts`, add this import near the other local imports:

```ts
import { WorkingVisibilityController } from "./working-visibility.js";
```

Near the existing state declarations for `planProgress`, `sessionPlanPaths`, and active tool maps, add:

```ts
  let workingVisibility: WorkingVisibilityController | null = null;
```

Update the existing `session_shutdown` handler to restore visibility before cleanup:

```ts
  pi.on("session_shutdown", async (_event, _ctx) => {
    workingVisibility?.restore();
    workingVisibility = null;
    sessionPlanPaths.clear();
    await cleanupActiveTeamTmuxResources();
  });
```

Inside the existing `session_start` handler, after `planProgress.clear();`, add:

```ts
    workingVisibility?.restore();
    workingVisibility = new WorkingVisibilityController(planProgress, ctx.ui);
    workingVisibility.start();
```

Expected: pi's default working row is hidden only when at least one loaded plan task is marked running, and it is restored when all plan tasks finish, when the plan is cleared, or when the session shuts down/reloads.

- [ ] **Step 4: Run focused tests**

Run:

```bash
cd extensions/agentic-harness
npm test -- --run tests/working-visibility.test.ts tests/plan-progress-events.test.ts
npm run build
```

Expected: focused tests and type-check pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/agentic-harness/working-visibility.ts extensions/agentic-harness/tests/working-visibility.test.ts extensions/agentic-harness/index.ts
git commit -m "feat: hide built-in working row during plan progress"
```

---

### Task 4: Document v0.72 compatibility and non-actionable release items

**Dependencies:** None (can run in parallel with Task 1)
**Files:**
- Modify: `extensions/agentic-harness/README.md`
- Modify: `extensions/session-loop/README.md`

- [ ] **Step 1: Add agentic-harness pi v0.72 compatibility note**

In `extensions/agentic-harness/README.md`, add this section after the existing `## Prerequisites` section and before `## Installation`:

```md
## pi v0.72 Compatibility Notes

This extension targets pi `0.72.x` and remains provider-agnostic. It does not register custom model providers itself.

For users or downstream extensions that add custom providers with `pi.registerProvider()` or `~/.pi/agent/models.json`:

- Use model-level `thinkingLevelMap` for pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). Do not use the removed `compat.reasoningEffortMap` shape.
- Use `null` values in `thinkingLevelMap` for thinking levels a model should hide and skip while cycling.
- Per-model `baseUrl` overrides are honored by pi `0.72.x`, so provider-wide proxies and model-specific endpoints can coexist.

Team-mode thinking-level UI is intentionally not part of this extension's default path. Team mode remains gated behind `PI_ENABLE_TEAM_MODE=1`.
```

- [ ] **Step 2: Document why `shouldStopAfterTurn` is not implemented in session-loop**

In `extensions/session-loop/README.md`, add this section after `## Architecture` and before `## Development`:

````md
## pi v0.72 Agent Loop Note

pi `0.72.x` added `shouldStopAfterTurn` to the low-level `@mariozechner/pi-agent-core` loop configuration. `session-loop` does not call `agentLoop()` directly; it schedules recurring prompts through the public ExtensionAPI:

```ts
pi.sendUserMessage(prompt, { deliverAs: "followUp" });
```

Because `shouldStopAfterTurn` is not exposed on `ExtensionAPI`, `ExtensionContext`, or `ExtensionCommandContext`, this extension cannot pass that callback into the active pi agent loop. `/loop-stop` and `/loop-stop-all` remain cooperative scheduler controls, and session shutdown still aborts active jobs through each job's `AbortController`.
````

- [ ] **Step 3: Verify documentation formatting**

Run:

```bash
git diff --check -- extensions/agentic-harness/README.md extensions/session-loop/README.md
```

Expected: no whitespace errors.

- [ ] **Step 4: Commit**

```bash
git add extensions/agentic-harness/README.md extensions/session-loop/README.md
git commit -m "docs: capture pi v0.72 compatibility boundaries"
```

---

### Task 5 (Final): End-to-End Verification

**Dependencies:** All preceding tasks
**Files:** None (read-only verification)

- [ ] **Step 1: Run highest-level verification**

Run from the repository root:

```bash
for dir in extensions/agentic-harness extensions/session-loop extensions/autonomous-dev extensions/fff-search extensions/workspace-memory; do
  (cd "$dir" && npm test && npm run build) || exit 1
done
git diff --check
```

Expected: all tests and builds pass, including any existing e2e-style Vitest files that run in the package suites; `git diff --check` reports no whitespace errors.

- [ ] **Step 2: Verify plan success criteria manually**

Check each item:
- [ ] All direct `@mariozechner/pi-coding-agent` dependencies in extension package manifests are pinned to `^0.72.1`.
- [ ] All direct `@mariozechner/pi-tui` dependencies in extension package manifests are pinned to `^0.72.1`.
- [ ] `extensions/agentic-harness/index.ts` still tracks cache stats in `message_end` and now also calls `loadPlanFromAssistantMessageEnd(...)`.
- [ ] `loadPlanFromAssistantMessageEnd(...)` loads assistant-finalized plan markdown and assistant-mentioned plan paths without clearing existing progress on unrelated assistant text.
- [ ] `WorkingVisibilityController` hides the built-in working row only while loaded plan tasks are running and restores it afterward.
- [ ] No files under `extensions/agentic-harness/team.ts` were modified.
- [ ] No `thinking_level_select` event handler was added.
- [ ] Documentation explains `thinkingLevelMap` compatibility and the `shouldStopAfterTurn` ExtensionAPI boundary.

- [ ] **Step 3: Inspect diff for excluded scope**

Run:

```bash
git diff --stat
git diff -- extensions/agentic-harness/team.ts
```

Expected: the `team.ts` diff is empty. The overall diff only includes files listed in this plan.

- [ ] **Step 4: Commit final verification note if needed**

If the project expects review notes in `tasks/todo.md`, append a short review block with the verification commands and results:

```bash
git add tasks/todo.md
git commit -m "docs: record pi v0.72 adoption verification"
```

Skip this commit if no `tasks/todo.md` change was made.

---

## Self-Review

- **Spec coverage:** Covers all useful non-team release items from the prior analysis: dependency/API adoption, `message_end`, `setWorkingVisible`, `thinkingLevelMap` compatibility docs, and `shouldStopAfterTurn` feasibility documentation. Explicitly excludes team mode and `thinking_level_select` UI work.
- **Placeholder scan:** No deferred-work placeholders are present. All code snippets, commands, paths, and expected outcomes are concrete.
- **Type consistency:** Helper names are consistent: `loadPlanFromAssistantMessageEnd`, `WorkingVisibilityController`, `setWorkingVisible`.
- **Dependency verification:** Tasks 2 and 3 both modify `extensions/agentic-harness/index.ts`, so Task 3 depends on Task 2. Task 4 modifies only docs and can run parallel with Task 1. Final verification depends on all tasks.
- **Verification coverage:** Final task runs all extension test suites/builds and checks excluded team-mode scope.
