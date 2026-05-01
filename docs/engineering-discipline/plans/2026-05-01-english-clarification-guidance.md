# English System Instructions for Clarification Priority

> **Worker note:** Execute this plan task-by-task using the agentic-run-plan skill or subagents. Each step uses checkbox (`- [ ]`) syntax for progress tracking.

**Goal:** Add English system instructions to the plugin's `before_agent_start` hook that guide the LLM to assess ambiguity and use clarification as the default entry point, while preventing re-triggering after clarification is complete.

**Architecture:** Append English guidance text to `PHASE_GUIDANCE["idle"]` that instructs the LLM to evaluate request clarity before implementing. Track "clarification completed" state via an in-memory boolean flag that persists through compaction, and inject a "clarification already done" notice when the flag is set.

**Tech Stack:** TypeScript, pi extension SDK (`before_agent_start` event hook)

**Work Scope:**
- **In scope:** English system prompt text in idle phase, clarification-completed flag, compaction persistence, flag reset on session start
- **Out of scope:** Changes to clarification skill logic, auto-detection of vague requests, other phase guidance changes

---

## File Structure Mapping

| File | Action | Purpose |
|------|--------|---------|
| `extensions/agentic-harness/index.ts` | Modify | Add English guidance to idle phase, add `clarificationDone` flag, persist in compaction, reset on session start |

---

## Verification Strategy

- **Level:** test-suite
- **Command:** `npm test` (or project-specific test command in `extensions/agentic-harness/`)
- **What it validates:** Phase guidance injection still works, compaction round-trip preserves new flag, session start resets flag

---

### Task 1: Add `clarificationDone` Flag and Reset Logic

**Dependencies:** None (can run in parallel)
**Files:**
- Modify: `extensions/agentic-harness/index.ts:42-49` (state declarations)
- Modify: `extensions/agentic-harness/index.ts:1597` (session_start handler)

- [ ] **Step 1: Add `clarificationDone` flag declaration**

In `index.ts`, after the existing state declarations (line 48-49), add:

```typescript
let clarificationDone: boolean = false;
```

- [ ] **Step 2: Reset flag on session_start**

In the `session_start` handler (line 1597), add after `activeGoalDocument = null;`:

```typescript
clarificationDone = false;
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `npm test` (from `extensions/agentic-harness/`)
Expected: All existing tests pass

---

### Task 2: Add English Guidance to Idle Phase

**Dependencies:** Task 1
**Files:**
- Modify: `extensions/agentic-harness/index.ts:853-854` (PHASE_GUIDANCE.idle)

- [ ] **Step 1: Define English guidance constant**

Before the `PHASE_GUIDANCE` object, add:

```typescript
const CLARIFICATION_PRIORITY_GUIDANCE = `

## Ambiguity Assessment

Before implementing any user request, assess whether the scope is clear:
- If the request is vague, ambiguous, or underspecified → use the agentic-clarification skill (invoke /clarify or follow its rules)
- If the request is trivially clear (single file, obvious fix) → proceed directly
- When in doubt → err on the side of clarification

Do not start multi-step implementation without a clear understanding of what the user wants.`;
```

- [ ] **Step 2: Inject guidance into idle phase**

Change `PHASE_GUIDANCE.idle` from empty string to conditionally include the guidance:

```typescript
idle: clarificationDone ? "" : CLARIFICATION_PRIORITY_GUIDANCE,
```

**Note:** Since `PHASE_GUIDANCE` is a static object initialized at module load, and `clarificationDone` is runtime state, we need to change the approach. Instead of using the static object, inject the guidance dynamically in the `before_agent_start` handler.

**Revised approach:** Modify the `before_agent_start` handler (line 907-924):

```typescript
pi.on("before_agent_start", async (event, _ctx) => {
  const isSkillInvocation = SKILL_INVOCATION_RE.test(event.prompt ?? "");
  const phaseGuidance = (isRootSession && !isSkillInvocation) ? PHASE_GUIDANCE[currentPhase] : "";
  
  // Inject clarification priority guidance when idle and clarification not yet done
  const idleGuidance = (isRootSession && !isSkillInvocation && currentPhase === "idle" && !clarificationDone) 
    ? CLARIFICATION_PRIORITY_GUIDANCE 
    : "";

  let delegationInfo = "";
  if (depthConfig.canDelegate && !isTeamWorker) {
    const agentList = (await discoverAgents(_ctx.cwd || ".", "user", BUNDLED_AGENTS_DIR))
      .map((a) => `- **${a.name}**: ${a.description}`)
      .join("\n");
    delegationInfo = `\n\n## Delegation Guards\n- Current depth: ${depthConfig.currentDepth}, max: ${depthConfig.maxDepth}\n- Cycle prevention: ${depthConfig.preventCycles ? "enabled" : "disabled"}\n- Ancestor stack: ${depthConfig.ancestorStack.length > 0 ? depthConfig.ancestorStack.join(" -> ") : "(root)"}\n\n## Available Subagents\n${agentList}`;
  }

  const combined = phaseGuidance + idleGuidance;
  if (!combined && !delegationInfo) return;
  return {
    systemPrompt: event.systemPrompt + combined + delegationInfo,
  };
});
```

- [ ] **Step 3: Run tests to verify guidance injection**

Run: `npm test`
Expected: All tests pass, including phase guidance injection tests

---

### Task 3: Set `clarificationDone` Flag on Context Brief Write

**Dependencies:** Task 1
**Files:**
- Modify: `extensions/agentic-harness/index.ts:1087-1093` (tool_result handler for phase auto-reset)

- [ ] **Step 1: Set flag when clarification phase auto-resets**

In the `tool_result` handler where phase auto-reset occurs (around line 1087-1093), add `clarificationDone = true` when the clarifying phase terminal directory is matched:

```typescript
if (toolName === "write") {
  const terminal = PHASE_TERMINAL_DIR[currentPhase];
  if (terminal && terminal.test(relativePath)) {
    if (currentPhase === "clarifying") {
      clarificationDone = true;
    }
    currentPhase = "idle";
    activeGoalDocument = null;
  }
}
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass

---

### Task 4: Persist `clarificationDone` in Compaction

**Dependencies:** Task 1
**Files:**
- Modify: `extensions/agentic-harness/index.ts:1013-1017` (session_before_compact)
- Modify: `extensions/agentic-harness/index.ts:1041-1045` (session_compact)

- [ ] **Step 1: Save flag during compaction**

In `session_before_compact` handler, add `clarificationDone` to the details object:

```typescript
details: { phase: currentPhase, activeGoalDocument, clarificationDone }
```

- [ ] **Step 2: Restore flag after compaction**

In `session_compact` handler, add restoration:

```typescript
if (details.clarificationDone !== undefined) {
  clarificationDone = details.clarificationDone as boolean;
}
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass, compaction round-trip tests verify flag persistence

---

### Task 5 (Final): End-to-End Verification

**Dependencies:** All preceding tasks
**Files:** None (read-only verification)

- [ ] **Step 1: Run full test suite**

Run: `npm test` (from `extensions/agentic-harness/`)
Expected: ALL PASS

- [ ] **Step 2: Verify plan success criteria**

Manually check each success criterion:
- [ ] English guidance appears in system prompt when phase is idle and clarification not done
- [ ] Guidance disappears after clarification context brief is written
- [ ] Flag persists through compaction
- [ ] Flag resets on new session
- [ ] No regressions in existing phase guidance behavior

- [ ] **Step 3: Manual smoke test**

Start pi with the extension loaded. Verify:
- [ ] On fresh session, system prompt includes ambiguity assessment guidance
- [ ] After writing a context brief, guidance no longer appears
- [ ] After `/reset-phase`, guidance reappears
