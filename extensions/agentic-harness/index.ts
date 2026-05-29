import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import { RoachFooter, type CacheStats, type ActiveTools, type ActiveToolStatus } from "./footer.js";
import { resolveAgenticUiSettings } from "./ui-settings.js";
import { shimmerText, type ShimmerPalette } from "./shimmer.js";
import { registerWelcomeCommand, showWelcomeHeader } from "./welcome-ui.js";
import { registerEditorStashCommands } from "./editor-stash.js";
import { installEditorComposition } from "./editor-composition.js";
import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { discoverAgents, type SubagentContextMode } from "./agents.js";
import { runAgent, mapWithConcurrencyLimit, MAX_CONCURRENCY, MAX_PARALLEL_TASKS, resolveDepthConfig, getCycleViolations } from "./subagent.js";
import { emptyUsage, getFinalOutput, isResultError, isResultSuccess, getResultSummaryText, type SingleResult, type SubagentDetails } from "./types.js";
import { renderCall, renderResult } from "./render.js";
import { readFileSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { microcompactMessages, getCompactionPrompt, formatCompactSummary, buildGoalCompactionSummary, buildClarificationCompactionSummary } from "./compaction.js";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { isDisciplineAgent, augmentAgentWithKarpathy } from "./discipline.js";
import {
  extractPlanPathsFromArgs,
  getToolExecutionArgs,
  subagentItemRecords,
} from "./legacy-import-markdown.js";
import {
  defaultHarnessStateRoot,
  harnessStateSnapshotPath,
  readHarnessStateSnapshot,
  writeHarnessStateSnapshot,
  createHarnessStateSnapshot,
} from "./harness-storage.js";
import {
  extractHarnessReplayEventsFromSessionEntries,
  HARNESS_STATE_EVENT_CUSTOM_TYPE,
  restoreHarnessStateFromSnapshotAndEvents,
} from "./harness-events.js";
import { createHarnessState, type HarnessState } from "./harness-state.js";
import { fetchUrlToMarkdown } from "./webfetch/utils.js";
import { PI_ENABLE_TEAM_MODE_ENV, PI_TEAM_WORKER_ENV, cleanupActiveTeamTmuxResources, formatTeamRunSummary, runTeam, type TeamBackend, type TeamRunSummary } from "./team.js";
import { defaultTeamRunStateRoot, listTeamRuns, readTeamRunRecord, writeTeamRunRecord, type StaleTaskResumeMode } from "./team-state.js";
import { buildTeamCommandPrompt, getTeamArgumentCompletions, isTeamFollowUpCommand, parseTeamArgs } from "./team-command.js";
import { renderWebfetchCall, renderWebfetchResult } from "./webfetch/render.js";
import { registerHarnessTools } from "./harness-tools.js";
import { HarnessProgressProvider } from "./harness-progress.js";
import { restoreTodosFromBranchEntries } from "./simple-todo.js";
import { applyStructuredPlanTaskStatusUpdates, selectStructuredPlanForPaths } from "./harness-runtime-progress.js";
import { withHarnessStateMutationLock } from "./harness-state-service.js";
import { getDefaultApprovalStore } from "./sandbox/approval-store.js";
import { parseSandboxApprovalMode } from "./sandbox/approval-mode.js";
import { createSandboxedBashOperations } from "./sandbox/bash-operations.js";
import { resolvePiAgentDir, resolvePiSessionDir } from "./sandbox/agent-dir.js";
import { makePolicyFingerprint } from "./sandbox/policy-engine.js";
import { isSensitiveEnvPath } from "./sandbox/sensitive-env.js";
import { execFile } from "child_process";
import { promisify } from "util";
import type { GitStats, ModelInfo } from "./footer.js";
import { GOAL_HELP_TEXT, parseGoalCommand } from "./goal-command.js";
import { renderGoalStatus, renderGoalSummary } from "./goal-render.js";
import { createGoalState, type GoalCommand, type GoalState } from "./goal-state.js";
import { defaultGoalStateRoot } from "./goal-storage.js";
import { applyAndPersistGoalCommand, loadGoalState, persistGoalState } from "./goal-state-service.js";
import {
  buildGoalVerifierPrompt,
  buildGoalVerifierReceipt,
  getGoalVerifierTarget,
  GOAL_VERIFIER_AGENT,
  parseGoalVerifierOutput,
} from "./goal-verifier.js";
import { planGoalContinuation } from "./goal-continuation.js";
import { extractGoalStateReplayEventsFromSessionEntries, restoreGoalStateFromSnapshotAndEvents } from "./goal-events.js";
import { defaultClarificationStateRoot } from "./clarification-storage.js";
import { applyAndPersistClarificationCommand, loadClarificationState, persistClarificationState } from "./clarification-state-service.js";
import { extractClarificationStateReplayEventsFromSessionEntries, restoreClarificationStateFromSnapshotAndEvents } from "./clarification-events.js";
import { renderClarificationGateSummary, type ClarificationCommand, type ClarificationGoalContract, type ClarificationState } from "./clarification-state.js";
import { resolveSessionScopedRunId } from "./runtime-run-id.js";

const execFileAsync = promisify(execFile);

type WorkflowPhase =
  | "idle"
  | "clarifying"
  | "goal_drafting"
  | "goal_active"
  | "goal_verifying"
  | "reviewing";

let currentPhase: WorkflowPhase = "idle";
let activeArtifactDocument: string | null = null;
let clarificationDone: boolean = false;
function normalizeWorkflowPhase(phase: string): WorkflowPhase | undefined {
  if (
    phase === "idle" ||
    phase === "clarifying" ||
    phase === "goal_drafting" ||
    phase === "goal_active" ||
    phase === "goal_verifying" ||
    phase === "reviewing"
  ) {
    return phase;
  }
  return undefined;
}


const cacheStats: CacheStats = { totalInput: 0, totalCacheRead: 0 };
const activeTools: ActiveTools = { running: new Map() };

async function computeGitStats(cwd: string): Promise<GitStats> {
  const result: GitStats = { ahead: 0, behind: 0, dirty: 0, untracked: 0 };

  try {
    const { stdout: abStdout } = await execFileAsync(
      "git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      { cwd, encoding: "utf-8", timeout: 3000 }
    );
    const parts = abStdout.trim().split("\t");
    if (parts.length === 2) {
      result.behind = Number(parts[0]) || 0;
      result.ahead = Number(parts[1]) || 0;
    }
  } catch {
    // No upstream or not a git repo
  }

  try {
    const { stdout: stStdout } = await execFileAsync(
      "git", ["status", "--porcelain"],
      { cwd, encoding: "utf-8", timeout: 3000 }
    );
    const lines = stStdout.trim().split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      if (line.startsWith("??")) {
        result.untracked++;
      } else {
        result.dirty++;
      }
    }
  } catch {
    // Not a git repo
  }

  return result;
}

function getModelInfo(ctx: any): ModelInfo {
  const model = ctx.model;
  if (!model) return { name: "no model", isLatest: false };

  const available = ctx.modelRegistry.getAvailable();
  const sameProvider = available.filter((m: any) => m.provider === model.provider);
  if (sameProvider.length === 0) return { name: model.name, isLatest: false };

  // Sort by contextWindow descending; highest is considered "latest" flagship
  sameProvider.sort((a: any, b: any) => b.contextWindow - a.contextWindow);
  const isLatest = sameProvider[0].id === model.id;

  return { name: model.name, isLatest };
}

const MICROCOMPACTION_ENV = "PI_AGENTIC_MICROCOMPACTION";

function isMicrocompactionEnabled(): boolean {
  return process.env[MICROCOMPACTION_ENV] === "1";
}

// Track tool call arguments by toolCallId so we can correlate plan-task
// subagent starts/completions across tool_execution_start/end events.
const toolCallArgsById = new Map<string, Record<string, unknown>>();
const planTaskIdsByToolCallId = new Map<string, number[]>();

let harnessProgress: HarnessProgressProvider | null = null;
let currentGoalFooterSummary: string | undefined;
let currentGoalCompactionSummary: string | null = null;
let currentClarificationCompactionSummary: string | null = null;
let latestClarificationState: ClarificationState | null = null;
let latestClarificationRootDir: string | null = null;
const goalFooterInvalidators = new Set<() => void>();
const WORKING_SHIMMER_INTERVAL_MS = 80;
const WORKING_BASE_MESSAGE = "Working…";
const WORKING_SHIMMER_PALETTE: ShimmerPalette = {
  low: "dim",
  mid: "accent",
  high: "warning",
  bold: true,
};
const WORKING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let workingUiContext: any | null = null;
let workingMessageBase = WORKING_BASE_MESSAGE;
let workingMessageTimer: ReturnType<typeof setInterval> | null = null;

function formatToolIntent(toolName: string, intent: unknown): string | undefined {
  if (typeof intent === "string" && intent.trim().length > 0) return intent.trim();
  return undefined;
}

function currentWorkingBaseMessage(activeTools: ActiveTools): string {
  const tools = [...activeTools.running.values()]
    .map((value) => typeof value === "string" ? { name: value, startedAt: 0 } : value)
    .sort((a, b) => b.startedAt - a.startedAt);
  const current = tools.find((tool) => tool.intent && tool.intent.trim().length > 0) ?? tools[0];
  return current?.intent?.trim() || current?.name || WORKING_BASE_MESSAGE;
}

function applyWorkingMessageFrame(ctx: any): void {
  if (!ctx?.ui?.setWorkingMessage || !ctx?.ui?.theme) return;
  ctx.ui.setWorkingMessage(shimmerText(workingMessageBase, ctx.ui.theme, WORKING_SHIMMER_PALETTE));
}

function configureWorkingIndicator(ctx: any): void {
  if (!ctx?.ui?.setWorkingIndicator || !ctx?.ui?.theme) return;
  ctx.ui.setWorkingIndicator({
    frames: WORKING_SPINNER_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
    intervalMs: WORKING_SHIMMER_INTERVAL_MS,
  });
}

function startWorkingMessageShimmer(ctx: any): void {
  workingUiContext = ctx;
  configureWorkingIndicator(ctx);
  applyWorkingMessageFrame(ctx);
  if (workingMessageTimer) return;
  workingMessageTimer = setInterval(() => {
    if (workingUiContext) applyWorkingMessageFrame(workingUiContext);
  }, WORKING_SHIMMER_INTERVAL_MS);
}

function stopWorkingMessageShimmer(): void {
  if (workingMessageTimer) {
    clearInterval(workingMessageTimer);
    workingMessageTimer = null;
  }
  if (workingUiContext?.ui?.setWorkingMessage) workingUiContext.ui.setWorkingMessage();
  workingUiContext = null;
  workingMessageBase = WORKING_BASE_MESSAGE;
}

function refreshWorkingMessageFromTools(ctx: any, activeTools: ActiveTools): void {
  workingMessageBase = currentWorkingBaseMessage(activeTools);
  if (workingUiContext || activeTools.running.size > 0) startWorkingMessageShimmer(ctx);
}
function extractExplicitPlanTaskIdsFromArgs(args: unknown): number[] {
  return [...new Set(subagentItemRecords(args)
    .filter((item) => item.agent === "plan-compliance" || item.agent === "plan-worker" || item.agent === "plan-validator")
    .map((item) => item.planTaskId)
    .filter((planTaskId): planTaskId is number => typeof planTaskId === "number" && Number.isInteger(planTaskId))
  )];
}

type StringEnumSchema<T extends string> = TUnsafe<T> & {
  type: "string";
  enum: T[];
};

function stringEnum<T extends string>(values: readonly T[], options: { description: string; default?: T }): StringEnumSchema<T> {
  return Type.Unsafe<T>({
    type: "string",
    enum: [...values],
    ...options,
  }) as StringEnumSchema<T>;
}

function preferTodoSurfaceTools(pi: any): void {
  try {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
      return;
    }
    const active = pi.getActiveTools();
    if (!Array.isArray(active)) return;
    pi.setActiveTools(active.filter((name: string) => name !== "harness_plan" && name !== "harness_todo"));
  } catch {
    // Ignore "Extension runtime not initialized" errors during early loading.
    // Will be retried on session_start.
  }
}

export default function (pi: ExtensionAPI) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const BUNDLED_AGENTS_DIR = join(__dirname, "agents");
  const BUNDLED_SKILLS_DIR = join(__dirname, "skills");
  const agentDir = resolvePiAgentDir();
  const sessionDir = resolvePiSessionDir();
  const piWritableRoots = Array.from(new Set([agentDir, ...(sessionDir ? [sessionDir] : [])]));

  const DIRECT_INPUT_OPTION = "Enter custom response";

  const depthConfig = resolveDepthConfig();
  const isRootSession = depthConfig.currentDepth === 0;
  const isTeamWorker = process.env[PI_TEAM_WORKER_ENV] === "1";
  const isTeamModeEnabled = process.env[PI_ENABLE_TEAM_MODE_ENV] === "1";
  const parsedApprovalMode = parseSandboxApprovalMode(process.env.PI_SANDBOX_APPROVAL_MODE);
  let warnedInvalidApprovalMode = false;
  let announcedAlwaysApprovalMode = false;
  const approvalStore = getDefaultApprovalStore();

  if (isRootSession) {
    const createRootApprovalResolver = (ctx?: { hasUI?: boolean; ui?: { select?: (message: string, choices: string[]) => Promise<string | undefined> } }) => {
      const hasUI = ctx?.hasUI !== false && !!ctx?.ui?.select;
      return async (request: { reason: string; command: string; args: string[] }) => {
        if (parsedApprovalMode.mode === "always") return { approved: true, scope: "session" as const };
        if (parsedApprovalMode.mode === "deny") return { approved: false };
        if (!hasUI) return { approved: false };
        const message = [
          "Sandbox escalation required to run unsandboxed.",
          `Reason: ${request.reason}`,
          `Command: ${request.command} ${request.args.join(" ")}`.trim(),
        ].join("\n");
        const choice = await ctx.ui!.select!(message, ["Deny", "Allow once", "Allow for session", "Always allow"]);
        if (choice === "Allow once") return { approved: true, scope: "once" as const };
        if (choice === "Allow for session") return { approved: true, scope: "session" as const };
        if (choice === "Always allow") return { approved: true, scope: "always" as const };
        return { approved: false };
      };
    };

    const createRootSandbox = (
      ctx?: { hasUI?: boolean; ui?: { select?: (message: string, choices: string[]) => Promise<string | undefined> } },
      requireApprovalForAllCommands = true,
    ) => ({
      enabled: true,
      workspaceRoot: process.cwd(),
      networkMode: "on" as const,
      additionalWritableRoots: piWritableRoots,
      approvalMode: parsedApprovalMode.mode,
      approvalResolver: createRootApprovalResolver(ctx),
      requireApprovalForAllCommands,
    });

    const shouldRegisterSandboxedBash = process.platform !== "darwin" || process.env.PI_AGENTIC_SANDBOX_BASH === "1";
    if (shouldRegisterSandboxedBash) {
      // Respect shellPath from settings.json so that the sandboxed bash uses the
      // user's configured shell (e.g. Git Bash) instead of default PATH resolution.
      let shellPath: string | undefined;
      try {
        const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
        const settingsRaw = readFileSync(settingsPath, "utf-8");
        const settings = JSON.parse(settingsRaw);
        shellPath = settings.shellPath;
      } catch {
        // Fall through — getShellConfig will use default resolution
      }
      const sandboxedBashOperations = createSandboxedBashOperations(createRootSandbox(), shellPath);
      const localBash = createBashTool(process.cwd(), { operations: sandboxedBashOperations });
      pi.registerTool({
        ...localBash,
        label: "bash (sandboxed)",
      });
      pi.on("user_bash", (_event, ctx) => ({
        operations: createSandboxedBashOperations(createRootSandbox(ctx as any, true), shellPath),
      }));
    }
  }

  const AskUserQuestionParams = Type.Object({
    question: Type.String({
      description: "The question to ask the user. The agent generates this dynamically based on context.",
    }),
    choices: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Multiple choice options generated by the agent. 'Enter custom response' is auto-appended. Omit for free-text input.",
      })
    ),
    placeholder: Type.Optional(
      Type.String({
        description: "Placeholder hint for free-text input mode.",
      })
    ),
    defaultValue: Type.Optional(
      Type.String({
        description: "Default value if user presses Enter without typing.",
      })
    ),
  });

  // ask_user_question is only available to the root session. Subagent
  // processes must not be able to call it — otherwise a subagent ends up
  // asking itself questions and answering them, since subagents run
  // non-interactively and have no user at the other end.
  if (isRootSession) {
    pi.registerTool({
        name: "ask_user_question",
        label: "Ask User Question",
        description:
          "Ask the user a question when the agent needs clarification. The agent composes the question and optional choices dynamically. Returns the user's answer as text.",
        promptSnippet:
          "Ask the user a clarifying question with optional multiple-choice answers",
        promptGuidelines: [
          "Use ask_user_question whenever you encounter ambiguity, unclear scope, or need user preference.",
          "Generate the question and choices yourself based on the current context — do not rely on predefined templates.",
          "Offer concrete choices (A/B/C style) when the options are enumerable. Omit choices for open-ended questions.",
          "Ask one focused question at a time. Do not bundle multiple questions.",
          "After receiving an answer, decide whether further clarification is needed or proceed with the task.",
        ],
        parameters: AskUserQuestionParams,
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
          const { question, choices, placeholder, defaultValue } = params;

          let answer: string | undefined;

          if (choices && choices.length > 0) {
            const withDirect = choices.includes(DIRECT_INPUT_OPTION)
              ? choices
              : [...choices, DIRECT_INPUT_OPTION];

            answer = await ctx.ui.select(question, withDirect, { signal });

            if (answer === DIRECT_INPUT_OPTION) {
              answer = await ctx.ui.input(question, placeholder || defaultValue, {
                signal,
              });
            }
          } else {
            answer = await ctx.ui.input(question, placeholder || defaultValue, {
              signal,
            });
          }

          if (answer === undefined) {
            return {
              content: [{ type: "text", text: "User cancelled the question." }],
              details: undefined,
            };
          }

          return {
            content: [{ type: "text", text: answer }],
            details: undefined,
          };
        },
      });
  }

  const ClarificationStateParams = Type.Object({
    action: Type.Union([
      Type.Literal("status"),
      Type.Literal("record_answer"),
      Type.Literal("record_exploration_finding"),
      Type.Literal("mark_checklist_item"),
      Type.Literal("add_ambiguity"),
      Type.Literal("resolve_ambiguity"),
      Type.Literal("accept_risk"),
      Type.Literal("draft_goal_contract"),
    ], { description: "Clarification state action" }),
    id: Type.Optional(Type.String({ description: "Item, ambiguity, answer, or finding id" })),
    checklistId: Type.Optional(Type.String({ description: "Required checklist id: objective, scope, non_goals, constraints, success_criteria, evidence_required, risks, edge_cases, technical_context" })),
    question: Type.Optional(Type.String({ description: "Question or ambiguity text" })),
    answer: Type.Optional(Type.String({ description: "User answer text" })),
    value: Type.Optional(Type.String({ description: "Checklist value or resolution text" })),
    topic: Type.Optional(Type.String({ description: "Exploration topic" })),
    summary: Type.Optional(Type.String({ description: "Exploration finding summary" })),
    files: Type.Optional(Type.Array(Type.String(), { description: "Files related to an exploration finding" })),
    blocking: Type.Optional(Type.Boolean({ description: "Whether an ambiguity blocks Goal Contract drafting" })),
    reason: Type.Optional(Type.String({ description: "Reason for accepting an ambiguity as risk" })),
    contract: Type.Optional(Type.Object({
      objective: Type.String(),
      scope: Type.Array(Type.String()),
      nonGoals: Type.Array(Type.String()),
      successCriteria: Type.Array(Type.String()),
      constraints: Type.Array(Type.String()),
      evidenceRequired: Type.Array(Type.String()),
      risks: Type.Array(Type.String()),
      suggestedSubgoals: Type.Array(Type.String()),
      handoffCommand: Type.String(),
    }, { description: "Goal Contract draft. Gate must pass before this is accepted." })),
  });

  if (isRootSession) {
    pi.registerTool({
      name: "clarification_state",
      label: "Clarification State",
      description: "Internal runtime state tool for deep /clarify interviews. Records checklist progress, user answers, exploration findings, unresolved ambiguities, accepted risks, and gated Goal Contract drafts.",
      promptSnippet: "Record hidden /clarify interview state and check the Goal Contract gate",
      promptGuidelines: [
        "Use clarification_state during /clarify to record every user answer and explorer finding.",
        "Mark each required checklist item only when it has concrete content.",
        "Add blocking ambiguities when objective, scope, non-goals, constraints, success criteria, evidence, risks, edge cases, or technical context are unclear.",
        "Call clarification_state with action=status before producing a Goal Contract.",
        "Do not draft a Goal Contract until clarification_state reports Gate: PASS.",
      ],
      parameters: ClarificationStateParams,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const toolCtx = ctx as any;
        const runId = resolveSessionScopedRunId(toolCtx);
        const rootDir = defaultClarificationStateRoot(toolCtx?.cwd || process.cwd());
        const refresh = (state: ClarificationState) => {
          latestClarificationState = state;
          latestClarificationRootDir = rootDir;
          currentClarificationCompactionSummary = buildClarificationCompactionSummary(state);
        };
        const apply = async (command: ClarificationCommand) => {
          const result = await applyAndPersistClarificationCommand(runId, rootDir, command, ctx);
          refresh(result.state);
          return result.state;
        };

        let state: ClarificationState;
        switch (params.action) {
          case "status":
            state = await loadClarificationState(runId, rootDir);
            break;
          case "record_answer":
            state = await apply({ type: "record_answer", id: params.id || `answer-${Date.now()}`, question: params.question || "", answer: params.answer || "" });
            break;
          case "record_exploration_finding":
            state = await apply({ type: "record_exploration_finding", id: params.id || `finding-${Date.now()}`, topic: params.topic || "codebase exploration", summary: params.summary || "", files: params.files });
            break;
          case "mark_checklist_item":
            state = await apply({ type: "mark_checklist_item", id: params.checklistId as any, value: params.value || "" });
            break;
          case "add_ambiguity":
            state = await apply({ type: "add_ambiguity", id: params.id || `ambiguity-${Date.now()}`, question: params.question || "", blocking: params.blocking });
            break;
          case "resolve_ambiguity":
            state = await apply({ type: "resolve_ambiguity", id: params.id || "", resolution: params.value || "" });
            break;
          case "accept_risk":
            state = await apply({ type: "accept_risk", id: params.id || "", reason: params.reason || params.value || "" });
            break;
          case "draft_goal_contract":
            if (!params.contract) throw new Error("contract is required for draft_goal_contract");
            state = await apply({ type: "draft_goal_contract", contract: params.contract });
            currentPhase = "goal_drafting";
            break;
          default:
            state = await loadClarificationState(runId, rootDir);
        }
        return { content: [{ type: "text", text: renderClarificationGateSummary(state) }], details: state };
      },
    });
  }

  const HEARTBEAT_MS = 1000;

  const TaskItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task to delegate to the agent" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
    output: Type.Optional(Type.String({ description: "Artifact-relative file path where the subagent should write its final output" })),
    reads: Type.Optional(Type.Array(Type.String(), { description: "Files to include as declared read context for the subagent" })),
    progress: Type.Optional(Type.String({ description: "Artifact-relative file path for progress notes" })),
    planFile: Type.Optional(Type.String({ description: "Path to plan file. Required when agent is plan-validator — the validator prompt is built from this file, not from the task field." })),
    planTaskId: Type.Optional(Type.Number({ description: "Task number in the plan file to validate (e.g. 1 for Task 1). Required when agent is plan-validator." })),
  });

  const ChainItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task with optional {previous} placeholder for prior step output" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
    output: Type.Optional(Type.String({ description: "Artifact-relative file path where the subagent should write its final output" })),
    reads: Type.Optional(Type.Array(Type.String(), { description: "Files to include as declared read context for the subagent" })),
    progress: Type.Optional(Type.String({ description: "Artifact-relative file path for progress notes" })),
    planFile: Type.Optional(Type.String({ description: "Path to plan file. Required when agent is plan-validator — the validator prompt is built from this file, not from the task field." })),
    planTaskId: Type.Optional(Type.Number({ description: "Task number in the plan file to validate (e.g. 1 for Task 1). Required when agent is plan-validator." })),
  });

  const SubagentParams = Type.Object({
    agent: Type.Optional(Type.String({ description: "Agent name for single mode execution" })),
    task: Type.Optional(Type.String({ description: "Task description for single mode execution" })),
    tasks: Type.Optional(Type.Array(TaskItem, { description: `Array of {agent, task} objects for parallel execution (max ${MAX_PARALLEL_TASKS})` })),
    chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} objects for sequential chaining. Use {previous} in task to reference prior output." })),
    agentScope: Type.Optional(stringEnum(["user", "project", "both"], {
      description: 'Which agent directories to search. Default: "user".',
      default: "user",
    })),
    cwd: Type.Optional(Type.String({ description: "Working directory for single mode" })),
    maxOutput: Type.Optional(Type.Number({ description: "Maximum characters of model-facing subagent output to return. Adds truncation metadata when applied." })),
    output: Type.Optional(Type.String({ description: "Artifact-relative file path where the subagent should write its final output" })),
    reads: Type.Optional(Type.Array(Type.String(), { description: "Files to include as declared read context for the subagent" })),
    progress: Type.Optional(Type.String({ description: "Artifact-relative file path for progress notes" })),
    context: Type.Optional(stringEnum(["fresh", "fork"], {
      description: "Session context mode. fresh preserves --no-session; fork requires PI_SUBAGENT_FORK_SESSION and fails fast if unavailable.",
    })),
    worktree: Type.Optional(Type.Boolean({ description: "Run parallel tasks in isolated git worktrees and capture per-task diffs." })),
    planFile: Type.Optional(Type.String({ description: "Path to plan file. Required when agent is plan-validator — the validator prompt is built from this file, not from the task field." })),
    planTaskId: Type.Optional(Type.Number({ description: "Task number in the plan file to validate (e.g. 1 for Task 1). Required when agent is plan-validator." })),
  });

  type AgentScope = "user" | "project" | "both";
  type TeamToolParams = {
    goal?: string;
    workerCount?: number;
    agent?: string;
    agentScope?: AgentScope;
    worktree?: boolean;
    worktreePolicy?: "off" | "on" | "auto";
    backend?: TeamBackend;
    maxOutput?: number;
    runId?: string;
    resumeRunId?: string;
    resumeMode?: StaleTaskResumeMode;
    staleTaskMs?: number;
    commandTarget?: string;
    commandMessage?: string;
  };
  type SubagentTaskParam = {
    agent: string;
    task: string;
    cwd?: string;
    output?: string;
    reads?: string[];
    progress?: string;
    planFile?: string;
    planTaskId?: number;
  };
  type SubagentToolParams = {
    agent?: string;
    task?: string;
    tasks?: SubagentTaskParam[];
    chain?: SubagentTaskParam[];
    agentScope?: AgentScope;
    cwd?: string;
    maxOutput?: number;
    output?: string;
    reads?: string[];
    progress?: string;
    context?: SubagentContextMode;
    worktree?: boolean;
    planFile?: string;
    planTaskId?: number;
  };

  const makeDetails = (mode: "single" | "parallel") => (results: SingleResult[]): SubagentDetails => ({ mode, results });

  const TeamParams = Type.Object({
    goal: Type.Optional(Type.String({ description: "Goal for the lightweight native team run. Omit only in follow-up command mode." })),
    workerCount: Type.Optional(Type.Number({ description: `Number of workers to dispatch (max ${MAX_PARALLEL_TASKS})` })),
    agent: Type.Optional(Type.String({ description: "Worker agent name. Default: worker" })),
    agentScope: Type.Optional(stringEnum(["user", "project", "both"], {
      description: 'Which agent directories to search. Default: "user".',
      default: "user",
    })),
    worktree: Type.Optional(Type.Boolean({ description: "Run team workers in isolated git worktrees" })),
    worktreePolicy: Type.Optional(stringEnum(["off", "on", "auto"], {
      description: "Worktree isolation policy. Defaults to the legacy worktree boolean behavior.",
    })),
    backend: Type.Optional(stringEnum(["auto", "native", "tmux"], {
      description: "Execution backend selection for team workers. auto prefers tmux when available.",
    })),
    maxOutput: Type.Optional(Type.Number({ description: "Maximum characters of model-facing worker output to retain" })),
    runId: Type.Optional(Type.String({ description: "Optional durable team run id for persisted state" })),
    resumeRunId: Type.Optional(Type.String({ description: "Resume a previously persisted team run id" })),
    resumeMode: Type.Optional(stringEnum(["mark-interrupted", "retry-stale"], {
      description: "How to handle stale in-progress tasks when resuming.",
    })),
    staleTaskMs: Type.Optional(Type.Number({ description: "Age in milliseconds before in-progress resume tasks are stale" })),
    commandTarget: Type.Optional(Type.String({ description: "Follow-up mode target worker owner or task id for an existing resumed run" })),
    commandMessage: Type.Optional(Type.String({ description: "Follow-up mode command message to enqueue for the target" })),
  });

  if (isRootSession && !isTeamWorker && isTeamModeEnabled) {
    pi.registerTool({
        name: "team",
        label: "Team",
        description: "Run a lightweight native team over existing pi subagents with structured task synthesis.",
        promptSnippet: "Coordinate a small team of bounded pi worker agents",
        promptGuidelines: [
          "Use team for coordinated multi-agent execution when a goal can be split into independent bounded tasks.",
          "Prefer small worker counts for the MVP; max parallel tasks is 12 with 10 concurrent.",
          "Workers must not recursively orchestrate or spawn subagents.",
          "Use subagent directly for simple one-off parallel dispatch without team synthesis.",
        ],
        parameters: TeamParams,
        renderCall: (args, theme) => renderCall(args, theme),
        renderResult: (result, { expanded }, theme) => renderResult(result, expanded, theme),
      execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
        const { goal, workerCount, agent, agentScope, worktree, worktreePolicy, backend, maxOutput, runId, resumeRunId, resumeMode, staleTaskMs, commandTarget, commandMessage } = params as TeamToolParams;
        const defaultCwd = ctx.cwd;
        const teamRunStateRoot = defaultTeamRunStateRoot(defaultCwd);
        const hasUI = (ctx as any).hasUI !== false && !!ctx?.ui?.select;
        const agents = await discoverAgents(defaultCwd, agentScope || "user", BUNDLED_AGENTS_DIR);
        const findAgent = (name: string) => agents.find((a) => a.name === name);
        const approvalResolver = async (request: { reason: string; command: string; args: string[]; cwd: string }) => {
          if (parsedApprovalMode.mode === "always") return { approved: true, scope: "session" as const };
          if (parsedApprovalMode.mode === "deny") return { approved: false };
          if (!hasUI) return { approved: false };
          const message = [
            "Sandbox escalation required to run unsandboxed.",
            `Reason: ${request.reason}`,
            `Command: ${request.command} ${request.args.join(" ")}`.trim(),
          ].join("\n");
          const choice = await ctx.ui.select(message, ["Deny", "Allow once", "Allow for session", "Always allow"], { signal });
          if (choice === "Allow once") return { approved: true, scope: "once" as const };
          if (choice === "Allow for session") return { approved: true, scope: "session" as const };
          if (choice === "Always allow") return { approved: true, scope: "always" as const };
          return { approved: false };
        };
        const sandboxFor = (runCwd: string) => ({
          enabled: true,
          workspaceRoot: defaultCwd,
          networkMode: "on" as const,
          additionalWritableRoots: [agentDir, runCwd],
          approvalMode: parsedApprovalMode.mode,
          approvalResolver,
          approvalStore,
          requireApprovalForAllCommands: true,
        });
        const indicatorSupported = hasUI && typeof ctx?.ui?.setWorkingIndicator === "function";
        if (indicatorSupported) ctx.ui.setWorkingIndicator({ frames: [] });
        let summary: TeamRunSummary;
        try {
          summary = await runTeam({ goal, workerCount, agent, worktree, worktreePolicy, backend, maxOutput, runId, resumeRunId, resumeMode, staleTaskMs, commandTarget, commandMessage, signal }, {
          findAgent,
          summarizeResult: getResultSummaryText,
          persistRun: async (record) => {
            await writeTeamRunRecord(record, teamRunStateRoot);
          },
          loadRun: (id) => readTeamRunRecord(id, teamRunStateRoot),
          emitProgress: (partial) => {
            const sessionName = partial.tasks.find((task) => task.terminal?.backend === "tmux" && task.terminal.sessionName)?.terminal?.sessionName;
            const backendTag = partial.backendUsed === "tmux"
              ? `[tmux: ${sessionName ?? "?"}]`
              : "[native]";
            onUpdate?.({
              content: [{ type: "text" as const, text: `Team ${backendTag}: ${partial.completedCount}/${partial.taskCount} completed, ${partial.failedCount} failed...` }],
              details: makeDetails("parallel")([]),
            });
          },
          emitBackendResolved: (info) => {
            if (!hasUI) return;
            if (info.requested === "auto" && info.used === "native") {
              ctx.ui.notify(
                "Tmux not detected — running team workers natively. Set backend=tmux to require tmux.",
                "info",
              );
            }
          },
          emitTmuxReady: (info) => {
            if (!hasUI) return;
            ctx.ui.notify(
              info.attachedToCurrentClient
                ? [
                  `Tmux team panes ready (${info.paneCount} workers).`,
                  "Opened worker panes in the current tmux window.",
                  `Per-worker logs: ${info.logDir}/task-N.log`,
                ].join("\n")
                : [
                  `Tmux team session ready (${info.paneCount} workers).`,
                  `Attach in another terminal:  ${info.attachCommand}`,
                  `Per-worker logs: ${info.logDir}/task-N.log`,
                ].join("\n"),
              "info",
            );
            ctx.ui.setStatus?.("harness", info.attachedToCurrentClient ? "Team running — current tmux window" : `Team running — ${info.attachCommand}`);
          },
          runTask: (input) => runAgent({
            agent: input.agent ? { ...input.agent, maxSubagentDepth: 1 } : undefined,
            agentName: input.agentName,
            task: input.prompt,
            cwd: defaultCwd,
            depthConfig,
            signal,
            sandbox: sandboxFor(defaultCwd),
            onUpdate,
            makeDetails: makeDetails("parallel"),
            maxOutput: input.maxOutput,
            contextMode: "fresh",
            worktree: input.worktree,
            executionMode: input.task.terminal?.backend === "tmux" ? "tmux" : "native",
            tmuxPane: input.task.terminal?.backend === "tmux" ? {
              sessionName: input.task.terminal.sessionName!,
              windowName: input.task.terminal.windowName!,
              paneId: input.task.terminal.paneId!,
              logFile: input.task.terminal.logFile!,
              eventLogFile: input.task.terminal.eventLogFile,
              attachCommand: input.task.terminal.attachCommand!,
              tmuxBinary: input.task.terminal.tmuxBinary,
              sessionAttempt: input.task.terminal.sessionAttempt,
            } : undefined,
            extraEnv: input.extraEnv,
          }),
        });
        } finally {
          if (indicatorSupported) ctx.ui.setWorkingIndicator();
        }
        return {
          content: [{ type: "text" as const, text: formatTeamRunSummary(summary) }],
          details: makeDetails("parallel")([]),
          isError: !summary.success,
          terminate: summary.success,
        };
      },
    });
  }

  if (depthConfig.canDelegate && !isTeamWorker) {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Delegate tasks to specialized agents running as separate pi processes. Supports single, parallel, and chain execution modes.",
      promptSnippet:
        "Delegate tasks to specialized agents (single, parallel, or chain mode)",
      promptGuidelines: [
        "Use single mode (agent + task) for one-off tasks. Use parallel mode (tasks array) for concurrent dispatch. Use chain mode (chain array) for sequential pipelines with {previous} placeholder.",
        "ONLY use these exact agent names — do NOT invent or guess agent names: explorer, worker, planner, plan-worker, plan-validator, plan-compliance, reviewer-feasibility, reviewer-architecture, reviewer-risk, reviewer-verifier.",
        "All agents use the default model. Do NOT specify or mention specific models (no Haiku, Sonnet, etc.).",
        "For codebase exploration: use 'explorer'. For general execution: use 'worker'. For active goals: follow /goal status and use 'reviewer-verifier' only through the goal completion guard.",
        "For implementation task validation: use 'plan-compliance' → 'plan-worker' → 'plan-validator' only when an active goal explicitly creates implementation task documents.",
        "Max 12 parallel tasks with 10 concurrent. Chain mode stops on first error.",
        "When calling plan-validator, provide planFile and planTaskId so the validator can load the task document under an information barrier.",
      ],
      parameters: SubagentParams,

      renderCall: (args, theme, context) => renderCall(args, theme, context),
      renderResult: (result, { expanded }, theme) => renderResult(result, expanded, theme),

      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const { agent, task, tasks, chain, agentScope, cwd, maxOutput, output, reads, progress, context, worktree } = params as SubagentToolParams;
        const hasUI = (ctx as any).hasUI !== false && !!ctx?.ui?.select;
        if (parsedApprovalMode.invalidRawValue && !warnedInvalidApprovalMode) {
          warnedInvalidApprovalMode = true;
          const message = `[agentic-harness] Invalid PI_SANDBOX_APPROVAL_MODE="${parsedApprovalMode.invalidRawValue}". Falling back to "ask".`;
          if (hasUI && ctx?.ui?.notify) ctx.ui.notify(message, "warning");
          else console.warn(message);
        }
        if (parsedApprovalMode.mode === "always" && !announcedAlwaysApprovalMode) {
          announcedAlwaysApprovalMode = true;
          const message = "[agentic-harness] Sandbox approval mode is \"always\" (YOLO). Unsandboxed fallback approvals are auto-allowed.";
          if (hasUI && ctx?.ui?.notify) ctx.ui.notify(message, "warning");
          else console.warn(message);
        }
        const defaultCwd = ctx.cwd;
        const agents = await discoverAgents(defaultCwd, agentScope || "user", BUNDLED_AGENTS_DIR);
        const findAgent = (name: string) => agents.find((a) => a.name === name);
        const approvalResolver = async (request: { reason: string; command: string; args: string[]; cwd: string }) => {
          if (parsedApprovalMode.mode === "always") return { approved: true, scope: "session" as const };
          if (parsedApprovalMode.mode === "deny") return { approved: false };
          if (!hasUI) return { approved: false };
          const message = [
            "Sandbox escalation required to run unsandboxed.",
            `Reason: ${request.reason}`,
            `Command: ${request.command} ${request.args.join(" ")}`.trim(),
          ].join("\n");
          const choice = await ctx.ui.select(
            message,
            ["Deny", "Allow once", "Allow for session", "Always allow"],
            { signal },
          );
          if (choice === "Allow once") return { approved: true, scope: "once" as const };
          if (choice === "Allow for session") return { approved: true, scope: "session" as const };
          if (choice === "Always allow") return { approved: true, scope: "always" as const };
          return { approved: false };
        };
        const sandboxFor = (runCwd: string) => ({
          // Subagents launch their own pi process and must be able to manage
          // child processes/signals for their own test suites. Do not sandbox
          // the subagent process itself; sandboxing for tools inside that
          // process is handled by that child pi session.
          enabled: false,
          workspaceRoot: defaultCwd,
          networkMode: "on" as const,
          additionalWritableRoots: Array.from(new Set([...piWritableRoots, runCwd])),
          approvalMode: parsedApprovalMode.mode,
          approvalResolver,
          approvalStore,
          requireApprovalForAllCommands: false,
        });

        const effectiveTaskFor = async (
          agentName: string,
          taskText: string,
          planFile?: string,
          planTaskId?: number,
        ) => {
          if (agentName !== "plan-validator" || !planFile || planTaskId == null) return taskText;
          try {
            const planContent = await readFile(planFile, "utf-8");
            const parserModule = await import(`.${"/"}${"pl"}an-parser.js`);
            const templateModule = await import(`.${"/"}validator-template.js`);
            const parsed = parserModule.parsePlan(planContent);
            const planTask = parsed.tasks.find((t: { id: number }) => t.id === planTaskId);
            return planTask ? templateModule.buildValidatorPrompt(planTask, parsed.verificationCommand) : taskText;
          } catch {
            return taskText;
          }
        };

        if (depthConfig.preventCycles) {
          const requested: string[] = [];
          if (agent) requested.push(agent);
          if (tasks) for (const t of tasks) requested.push(t.agent);
          if (chain) for (const s of chain) requested.push(s.agent);
          const violations = getCycleViolations(requested, depthConfig.ancestorStack);
          if (violations.length > 0) {
            return {
              content: [{ type: "text" as const, text: `Blocked: delegation cycle detected. Agents already in stack: ${violations.join(", ")}. Stack: ${depthConfig.ancestorStack.join(" -> ") || "(root)"}` }],
              details: makeDetails("single")([]),
              isError: true,
            };
          }
        }

        if (chain && chain.length > 0) {
          let previousOutput = "";
          const allResults: SingleResult[] = [];

          for (let i = 0; i < chain.length; i++) {
            const step = chain[i];
            const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
            const effectiveTask = await effectiveTaskFor(step.agent, taskWithContext, step.planFile, step.planTaskId);
            const chainAgent = isDisciplineAgent(step.agent)
              ? augmentAgentWithKarpathy(findAgent(step.agent))
              : findAgent(step.agent);
            const result = await runAgent({
              agent: chainAgent,
              agentName: step.agent,
              task: effectiveTask,
              cwd: step.cwd || defaultCwd,
              depthConfig,
              signal,
              onUpdate,
              sandbox: sandboxFor(step.cwd || defaultCwd),
              makeDetails: makeDetails("single"),
              maxOutput,
              output: step.output,
              reads: step.reads,
              progress: step.progress,
              contextMode: context,
            });
            allResults.push(result);

            if (isResultError(result)) {
              const summary = allResults.map((r, j) => `[${chain[j].agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r, maxOutput)}`).join("\n\n");
              return {
                content: [{ type: "text" as const, text: `Chain failed at step ${i + 1}: ${result.errorMessage || "error"}\n\n${summary}` }],
                details: makeDetails("single")(allResults),
                isError: true,
              };
            }
            previousOutput = getResultSummaryText(result, maxOutput);
          }

          const summary = allResults.map((r, i) => `[${chain[i].agent}] completed: ${getResultSummaryText(r, maxOutput)}`).join("\n\n");
          return {
            content: [{ type: "text" as const, text: summary }],
            details: makeDetails("single")(allResults),
          };
        }

        if (tasks && tasks.length > 0) {
          if (tasks.length > MAX_PARALLEL_TASKS) {
            return {
              content: [{ type: "text" as const, text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
              details: makeDetails("parallel")([]),
            };
          }

          const allResults: SingleResult[] = tasks.map((t) => ({
            agent: t.agent, agentSource: "unknown" as const, task: t.task,
            exitCode: -1, messages: [], stderr: "", usage: emptyUsage(),
          }));

          const emitProgress = () => {
            if (!onUpdate) return;
            const done = allResults.filter((r) => r.exitCode !== -1).length;
            const running = allResults.filter((r) => r.exitCode === -1).length;
            onUpdate({
              content: [{ type: "text" as const, text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
              details: makeDetails("parallel")([...allResults]),
            });
          };

          let heartbeat: ReturnType<typeof setInterval> | undefined;
          if (onUpdate) {
            emitProgress();
            heartbeat = setInterval(() => {
              if (allResults.some((r) => r.exitCode === -1)) emitProgress();
            }, HEARTBEAT_MS);
          }

          let results: SingleResult[];
          try {
            results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
              const effectiveTask = await effectiveTaskFor(t.agent, t.task, t.planFile, t.planTaskId);
              const parallelAgent = isDisciplineAgent(t.agent)
                ? augmentAgentWithKarpathy(findAgent(t.agent))
                : findAgent(t.agent);
              const result = await runAgent({
                agent: parallelAgent,
                agentName: t.agent,
                task: effectiveTask,
                cwd: t.cwd || defaultCwd,
                depthConfig,
                signal,
                sandbox: sandboxFor(t.cwd || defaultCwd),
                onUpdate: (partial) => {
                  if (partial.details?.results[0]) {
                    allResults[index] = partial.details.results[0];
                    emitProgress();
                  }
                },
                makeDetails: makeDetails("parallel"),
                maxOutput,
                output: t.output,
                reads: t.reads,
                progress: t.progress,
                contextMode: context,
                worktree,
              });
              allResults[index] = result;
              emitProgress();
              return result;
            });
          } finally {
            if (heartbeat) clearInterval(heartbeat);
          }

          const successCount = results.filter((r) => isResultSuccess(r)).length;
          const summaries = results.map((r) =>
            `[${r.agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r, maxOutput)}`,
          );
          return {
            content: [{ type: "text" as const, text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
            details: makeDetails("parallel")(results),
          };
        }

        if (agent && task) {
          const effectiveTask = await effectiveTaskFor(agent, task, params.planFile, params.planTaskId);

          const singleAgent = isDisciplineAgent(agent)
            ? augmentAgentWithKarpathy(findAgent(agent))
            : findAgent(agent);
          const result = await runAgent({
            agent: singleAgent,
            agentName: agent,
            task: effectiveTask,
            cwd: cwd || defaultCwd,
            depthConfig,
            signal,
            sandbox: sandboxFor(cwd || defaultCwd),
            onUpdate,
            makeDetails: makeDetails("single"),
            maxOutput,
            output,
            reads,
            progress,
            contextMode: context,
          });

          if (isResultError(result)) {
            return {
              content: [{ type: "text" as const, text: `Agent ${result.stopReason || "failed"}: ${getResultSummaryText(result, maxOutput)}` }],
              details: makeDetails("single")([result]),
              isError: true,
            };
          }
          return {
            content: [{ type: "text" as const, text: getResultSummaryText(result, maxOutput) }],
            details: makeDetails("single")([result]),
          };
        }

        return {
          content: [{ type: "text" as const, text: "Error: Specify either (agent + task) for single mode, tasks for parallel mode, or chain for chain mode." }],
          details: makeDetails("single")([]),
        };
      },
    });
  }

  const WebFetchParams = Type.Object({
    url: Type.String({
      description: "The URL to fetch and convert to Markdown",
    }),
    raw: Type.Optional(
      Type.Boolean({
        description:
          "Convert the full HTML page to Markdown without filtering",
        default: false,
      }),
    ),
    includeScripts: Type.Optional(
      Type.Boolean({
        description:
          "Include <script> and <style> tag content in the output. Default: false (stripped)",
        default: false,
      }),
    ),
    maxLength: Type.Optional(
      Type.Number({
        description:
          "Maximum number of characters to return. Content beyond this limit is truncated.",
      }),
    ),
  });

  pi.registerTool({
    name: "webfetch",
    label: "WebFetch",
    description:
      "Fetch a URL and convert its HTML content to clean Markdown. Uses Turndown + GFM for Markdown conversion. Results are cached for 15 minutes.",
    promptSnippet: "Fetch a URL and convert to Markdown",
    promptGuidelines: [
      "Use webfetch to retrieve and read web pages, documentation, or any URL content.",
      "Script and style tags are stripped by default. Use includeScripts: true when you need CSS/JS source code.",
      "Use raw: true when you need the full HTML page converted without any filtering.",
      "Use maxLength to limit output size for very large pages.",
      "Results are cached for 15 minutes — repeated requests for the same URL return instantly.",
    ],
    parameters: WebFetchParams,

    renderCall: (args, theme) => renderWebfetchCall(args, theme),
    renderResult: (result, { expanded }, theme) =>
      renderWebfetchResult(result, expanded, theme),

    execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
      const { url, raw, maxLength, includeScripts } = params;
      try {
        const { content, details } = await fetchUrlToMarkdown(url, {
          raw,
          maxLength,
          includeScripts,
          signal,
        });
        return {
          content: [{ type: "text" as const, text: content }],
          details,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching ${url}: ${message}`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
    },
  });

  registerHarnessTools(pi);
  // Try now (may fail if runtime not initialized — caught and retried on session_start)
  preferTodoSurfaceTools(pi);

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopWorkingMessageShimmer();
    harnessProgress = null;
    await cleanupActiveTeamTmuxResources();
  });

  pi.on("resources_discover", async (_event, _ctx) => {
    return {
      skillPaths: [BUNDLED_SKILLS_DIR],
    };
  });

  const clarificationQuestionRule = isRootSession
    ? "- Ask ONE question per message using the ask_user_question tool."
    : "- Do not ask the user questions directly. If information is missing, state the gap clearly in your output.";
  const CLARIFICATION_PRIORITY_GUIDANCE = `

## Ambiguity Assessment

Before implementing any user request, assess whether the scope is clear:
- If the request is vague, ambiguous, or underspecified → use the agentic-clarification skill (invoke /clarify or follow its rules)
- If the request is trivially clear (single file, obvious fix) → proceed directly
- When in doubt → err on the side of clarification

Do not start multi-step implementation without a clear understanding of what the user wants.`;

  const PHASE_GUIDANCE: Record<WorkflowPhase, string> = {
    idle: "",
    clarifying: [
      "\n\n## Active Workflow: Runtime-Enforced Deep Clarification",
      "You are in agentic-clarification mode. Follow the agentic-clarification skill rules strictly:",
      clarificationQuestionRule,
      "- Generate questions and choices dynamically based on context — no predefined templates.",
      "- Use the subagent tool with agent 'explorer' to investigate the codebase in parallel with user Q&A.",
      "- Use clarification_state after every user answer and explorer finding to update the hidden interview runtime.",
      "- Required checklist: objective, scope, non-goals, constraints, success criteria, evidence required, risks, edge cases, and technical context.",
      "- Track dynamic unresolved ambiguities as blocking unless the user explicitly accepts them as risk.",
      "- Before producing a Goal Contract, call clarification_state with action=status and verify Gate: PASS.",
      "- When Gate: PASS, call clarification_state with action=draft_goal_contract, then present the Goal Contract with a plain /goal handoff.",
      "- Do NOT start implementation during clarification.",
    ].join("\n"),
    goal_drafting: [
      "\n\n## Active Workflow: Goal Drafting",
      "You are converting clarified intent into a Goal Contract for the /goal runtime.",
      "- Capture objective, scope, success criteria, constraints, evidence required, risks, and suggested initial subgoals.",
      "- Make the handoff explicit with /goal; do not ask the user to type /goal create or /goal activate in the normal flow.",
      "- Do NOT start implementation until a goal is active.",
    ].join("\n"),
    goal_active: [
      "\n\n## Active Workflow: Active Goal",
      "You are working under the durable /goal runtime.",
      "- Use /goal status to inspect the active goal or subgoal before deciding next work.",
      "- Use todoread before todo status changes and todowrite immediately after task progress.",
      "- Maintain the evidence ledger with /goal evidence before requesting completion.",
      "- Completion requires verifier PASS; never claim the goal or subgoal is complete before that receipt exists.",
      "- There is no plan checkbox requirement unless the active goal explicitly creates todos or plan files.",
    ].join("\n"),
    goal_verifying: [
      "\n\n## Active Workflow: Goal Verification",
      "The active goal or subgoal is waiting for verifier review.",
      "- Completion requires verifier PASS from reviewer-verifier.",
      "- If verification fails, continue work on the reported blockers and add new evidence before requesting completion again.",
      "- Do not self-attest completion.",
    ].join("\n"),
    reviewing: [
      "\n\n## Active Workflow: Code Review (/review)",
      "You are in single-pass code review mode:",
      "- Resolve the review target (PR or local diff) as described in the user prompt.",
      "- Read the diff and the files it touches.",
      "- Produce a single integrated review across bug / security / performance / test coverage / consistency dimensions.",
      "- Output the review directly to chat. Do NOT save to a file. Do NOT dispatch subagents.",
      "- If the diff is empty, report 'No changes to review' and stop.",
    ].join("\n"),
  };

  // Matches user turns that are claude-code skill/command invocations. We suppress
  // phase guidance for these turns so the invoked skill's own instructions are not
  // overridden by a stale workflow phase (e.g. a previous goal flow was left active,
  // never reset-phase, and today invokes /systematic-debugging).
  const SKILL_INVOCATION_RE = /<command-name>|<command-message>|\[skill\]/;

  // Goal progress tracking — always injected into system prompt.
  // The structured todo state drives real-time footer progress, while the /goal
  // evidence ledger records durable proof for verifier-gated completion.
  const PROGRESS_TRACKING_RULES = [
    "\n\n## Goal Progress Tracking (NON-NEGOTIABLE)",
    "",
    "**Hard Rules:**",
    "",
    "1. **todoread before status changes**: Read the current todo state before changing task status.",
    "2. **todowrite immediately after progress**: Update todos as soon as task progress changes. Never defer to later.",
    "3. **Goal evidence before completion**: Append evidence to the /goal evidence ledger before requesting completion.",
    "4. **Verifier-gated completion**: Never claim a goal or subgoal is complete before reviewer-verifier returns PASS.",
    "5. **Plan checkboxes are conditional**: Only update plan markdown checkboxes when the active goal explicitly creates todos or plan files that require them.",
    "",
    "**Why**: The footer reads structured todo state for progress, and /goal completion is durable only after evidence plus verifier PASS.",
  ].join("\n");

  pi.on("before_agent_start", async (event, ctx) => {
    workingMessageBase = currentWorkingBaseMessage(activeTools);
    startWorkingMessageShimmer(ctx);
    const isSkillInvocation = SKILL_INVOCATION_RE.test(event.prompt ?? "");
    const phaseGuidance = (isRootSession && !isSkillInvocation) ? PHASE_GUIDANCE[currentPhase] : "";
    const idleGuidance = (isRootSession && !isSkillInvocation && currentPhase === "idle" && !clarificationDone)
      ? CLARIFICATION_PRIORITY_GUIDANCE
      : "";

    let delegationInfo = "";
    if (depthConfig.canDelegate && !isTeamWorker) {
      const agentList = (await discoverAgents(ctx.cwd || ".", "user", BUNDLED_AGENTS_DIR))
        .map((a) => `- **${a.name}**: ${a.description}`)
        .join("\n");
      delegationInfo = `\n\n## Delegation Guards\n- Current depth: ${depthConfig.currentDepth}, max: ${depthConfig.maxDepth}\n- Cycle prevention: ${depthConfig.preventCycles ? "enabled" : "disabled"}\n- Ancestor stack: ${depthConfig.ancestorStack.length > 0 ? depthConfig.ancestorStack.join(" -> ") : "(root)"}\n\n## Available Subagents\n${agentList}`;
    }

    const combined = phaseGuidance + idleGuidance;
    // Always inject progress tracking rules (they are unconditional).
    // Phase guidance and delegation info are conditional.
    return {
      systemPrompt: event.systemPrompt + PROGRESS_TRACKING_RULES + combined + delegationInfo,
    };
  });

  pi.on("context", async (event, _ctx) => {
    if (!isMicrocompactionEnabled()) return;

    const compacted = microcompactMessages(event.messages);
    const changed = compacted.some((msg, i) => msg !== event.messages[i]);
    if (!changed) return;
    return { messages: compacted };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    // Skip custom compaction for idle phase with no active artifact document —
    // let pi's default compaction handle simple conversations.
    if (currentPhase === "idle" && !activeArtifactDocument && !currentGoalCompactionSummary) return;

    const { preparation, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No model available, using default compaction", "warning");
      return;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify("Compaction auth failed, using default compaction", "warning");
      return;
    }

    const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
    if (allMessages.length === 0) return;

    ctx.ui.notify(
      `Custom compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens)...`,
      "info",
    );

    const conversationText = serializeConversation(convertToLlm(allMessages));

    const promptText = getCompactionPrompt(
      currentPhase,
      activeArtifactDocument,
      event.customInstructions,
      currentGoalCompactionSummary,
      currentClarificationCompactionSummary,
    );

    const previousContext = previousSummary
      ? `\n\nPrevious session summary for context:\n${previousSummary}`
      : "";

    const summaryMessages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `${promptText}${previousContext}\n\n<conversation>\n${conversationText}\n</conversation>`,
          },
        ],
        timestamp: Date.now(),
      },
    ];

    try {
      const response = await complete(
        model,
        { messages: summaryMessages },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 8192,
          signal,
        },
      );

      const summary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      if (!summary.trim()) {
        if (!signal.aborted) {
          ctx.ui.notify("Compaction summary was empty, using default", "warning");
        }
        return;
      }

      const formattedSummary = formatCompactSummary(summary);

      return {
        compaction: {
          summary: formattedSummary,
          firstKeptEntryId,
          tokensBefore,
          details: {
            phase: currentPhase,
            activeArtifactDocument,
            goalStateSummary: currentGoalCompactionSummary,
            clarificationDone,
          },
        },
      };
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Compaction failed: ${message}`, "error");
      return;
    }
  });

  pi.on("session_compact", async (event, _ctx) => {
    // Mirror the before_agent_start subagent guard: subagents never inherit
    // workflow phase state, even via compaction round-trips. Keeps phase
    // strictly isolated to the root session.
    if (!isRootSession) return;

    if (event.fromExtension && event.compactionEntry.details) {
      const details = event.compactionEntry.details as {
        phase?: string;
        activeArtifactDocument?: string | null;
        goalStateSummary?: string | null;
        clarificationDone?: boolean;
      };
      currentPhase = details.phase ? (normalizeWorkflowPhase(details.phase) ?? "idle") : currentPhase;
      if (details.activeArtifactDocument !== undefined) {
        activeArtifactDocument = details.activeArtifactDocument;
      }
      if (details.goalStateSummary !== undefined) {
        currentGoalCompactionSummary = details.goalStateSummary;
      }
      if (details.clarificationDone !== undefined) {
        clarificationDone = details.clarificationDone as boolean;
      }
    }
  });

  const GOAL_DOC_PATTERN = /^docs\/engineering-discipline\/(context|plans|reviews)\//;

  // Maps each non-idle phase to the regex for the directory whose fresh write signals phase completion.
  // A write to the matching directory flips currentPhase back to "idle" so the workflow guidance stops
  // riding on subsequent turns. Edits are ignored — only initial writes (new files) count as completion.
  const PHASE_TERMINAL_DIR: Partial<Record<WorkflowPhase, RegExp>> = {
    clarifying: /^docs\/engineering-discipline\/context\//,
    reviewing: /^docs\/engineering-discipline\/reviews\//,
  };

  pi.on("tool_result", async (event, ctx) => {
    const toolName = event.toolName;

    if (toolName === "harness_milestone" || toolName === "harness_plan" || toolName === "harness_todo") {
      const input = event.input as Record<string, unknown> | undefined;
      const runId = typeof input?.runId === "string" ? input.runId : undefined;
      const inputRootDir = typeof input?.rootDir === "string" ? input.rootDir : undefined;
      if (runId) {
        if (!harnessProgress) {
          harnessProgress = new HarnessProgressProvider();
        }
        const current = harnessProgress.getRunIdentity();
        const rootDir = inputRootDir ?? (current.runId === runId ? current.rootDir : undefined);
        harnessProgress.setRun(runId, rootDir);
      }
    }

    if (currentPhase === "idle") return;

    if (toolName !== "write" && toolName !== "edit") return;

    const filePath = event.input.path as string | undefined;
    if (!filePath) return;

    const relativePath = filePath.replace(/^.*?docs\/engineering-discipline\//, "docs/engineering-discipline/");
    if (!GOAL_DOC_PATTERN.test(relativePath)) return;

    activeArtifactDocument = relativePath;

    // Auto-reset phase when the current phase's terminal artifact is written (not edited).
    // Clear activeArtifactDocument too so this matches /reset-phase semantics — otherwise the
    // session_before_compact early-return gate stays open with a stale artifact pointer.
    if (toolName === "write") {
      const terminal = PHASE_TERMINAL_DIR[currentPhase];
      if (terminal && terminal.test(relativePath)) {
        if (currentPhase === "clarifying") {
          clarificationDone = true;
        }
        currentPhase = "idle";
        activeArtifactDocument = null;
      }
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolCallId) {
      toolCallArgsById.set(event.toolCallId, event.input ?? {});
    }

    const hasUI = (ctx as any).hasUI !== false && !!ctx?.ui?.select;

    if (isToolCallEventType("bash", event)) {
      if (parsedApprovalMode.mode === "always") return;
      if (parsedApprovalMode.mode === "deny") {
        return {
          block: true,
          reason: "Bash command execution is blocked by PI_SANDBOX_APPROVAL_MODE=deny.",
        };
      }

      const command = typeof event.input?.command === "string" ? event.input.command : "";
      const cwd = ctx.cwd || process.cwd();
      const policyFingerprint = makePolicyFingerprint({
        platform: process.platform,
        cwd,
        workspaceRoot: process.cwd(),
        fsMode: "workspace-write",
        networkMode: "on",
      });
      const fallbackReason = "Policy requires explicit approval before command execution.";
      const approvalKey = `${policyFingerprint}:${fallbackReason}`;
      const cached = approvalStore.getApprovedScope(approvalKey);
      if (cached === "session" || cached === "always") return;

      if (!hasUI) {
        return {
          block: true,
          reason: "Bash commands require interactive approval in ask mode.",
        };
      }

      const choice = await ctx.ui.select(
        [
          "Bash command execution requested.",
          `Command: ${command || "(empty)"}`,
          "Allow this command?",
        ].join("\n"),
        ["Deny", "Allow once", "Allow for session", "Always allow"],
      );

      if (choice === "Allow once") return;
      if (choice === "Allow for session") {
        await approvalStore.setApprovedScope(approvalKey, "session");
        return;
      }
      if (choice === "Always allow") {
        await approvalStore.setApprovedScope(approvalKey, "always");
        return;
      }
      return {
        block: true,
        reason: "Bash command denied by user approval.",
      };
    }

    if (!isToolCallEventType("read", event)) return;
    const inputPath = event.input?.path;
    if (!inputPath || typeof inputPath !== "string") return;
    if (!isSensitiveEnvPath(inputPath, ctx.cwd)) return;
    if (parsedApprovalMode.mode === "always") return;
    if (parsedApprovalMode.mode === "deny") {
      return {
        block: true,
        reason: "Sensitive .env* reads are blocked by PI_SANDBOX_APPROVAL_MODE=deny.",
      };
    }

    const cwd = ctx.cwd || process.cwd();
    const resolved = resolve(cwd, inputPath);
    const approvalKey = `sensitive-env-read:${resolved}`;
    const cached = approvalStore.getApprovedScope(approvalKey);
    if (cached === "session" || cached === "always") return;

    if (!hasUI) {
      return {
        block: true,
        reason: "Sensitive .env* reads require interactive approval in ask mode.",
      };
    }

    const choice = await ctx.ui.select(
      [
        "Sensitive .env* read requested.",
        `Path: ${resolved}`,
        "Allow this read?",
      ].join("\n"),
      ["Deny", "Allow once", "Allow for session", "Always allow"],
    );

    if (choice === "Allow once") return;
    if (choice === "Allow for session") {
      await approvalStore.setApprovedScope(approvalKey, "session");
      return;
    }
    if (choice === "Always allow") {
      await approvalStore.setApprovedScope(approvalKey, "always");
      return;
    }
    return {
      block: true,
      reason: "Sensitive .env* read denied by user approval.",
    };
  });

  pi.registerCommand("clarify", {
    description:
      "Start agentic-clarification — the agent asks dynamic questions to resolve ambiguity",
    handler: async (args, ctx) => {
      const topic = args?.trim() || "";
      const start = await ctx.ui.confirm(
        "Start Deep Clarification",
        "The agent will ask one focused question at a time, explore the codebase in parallel, and use a hidden runtime checklist so a Goal Contract is not drafted until ambiguity is resolved or accepted as risk.\n\nProceed?"
      );
      if (!start) return;

      currentPhase = "clarifying";
      activeArtifactDocument = null;
      const commandCtx = ctx as any;
      const clarificationRunId = resolveSessionScopedRunId(commandCtx);
      const clarificationRootDir = defaultClarificationStateRoot(commandCtx?.cwd || process.cwd());
      const started = await applyAndPersistClarificationCommand(clarificationRunId, clarificationRootDir, { type: "start_interview", topic }, ctx);
      latestClarificationState = started.state;
      latestClarificationRootDir = clarificationRootDir;
      currentClarificationCompactionSummary = buildClarificationCompactionSummary(started.state);
      ctx.ui.setStatus("harness", "Deep clarification in progress...");

      const prompt = topic
        ? isRootSession
          ? `The user wants to clarify the following request: "${topic}"\n\nBegin the runtime-enforced deep agentic-clarification process. Follow the agentic-clarification skill rules. Ask ONE question using the ask_user_question tool. Use the subagent tool with agent 'explorer' to investigate relevant parts of the codebase in parallel. Use the clarification_state tool after every user answer and explorer finding. Before producing a Goal Contract, call clarification_state with action=status and only draft the Goal Contract after the hidden checklist and ambiguity gate reports Gate: PASS. When the gate passes, call clarification_state with action=draft_goal_contract, then produce a Goal Contract with an exact /goal handoff and stop.`
          : `The user wants to clarify the following request: "${topic}"\n\nBegin the runtime-enforced deep agentic-clarification process. Follow the agentic-clarification skill rules. Do not ask the user questions directly. If information is missing, state the missing information clearly in your output. Use the subagent tool with agent 'explorer' to investigate relevant parts of the codebase in parallel. If clarification_state is available, record concrete findings and do not draft a Goal Contract until the checklist and ambiguity gate passes.`
        : isRootSession
          ? `The user wants to start a runtime-enforced deep agentic-clarification session for their current task.\n\nFollow the agentic-clarification skill rules. Ask ONE question using the ask_user_question tool to understand what the user wants to accomplish. Use the subagent tool with agent 'explorer' to investigate the codebase in parallel. Use clarification_state after every answer and explorer finding. Before producing a Goal Contract, call clarification_state with action=status and only draft after Gate: PASS. When the gate passes, call clarification_state with action=draft_goal_contract, then produce a Goal Contract with an exact /goal handoff and stop.`
          : `The user wants to start a runtime-enforced deep agentic-clarification session for their current task.\n\nFollow the agentic-clarification skill rules. Do not ask the user questions directly. If information is missing, state the missing information clearly in your output. Use the subagent tool with agent 'explorer' to investigate the codebase in parallel. If clarification_state is available, record concrete findings and do not draft a Goal Contract until the checklist and ambiguity gate passes.`;

      pi.sendUserMessage(prompt);
    },
  });

  const goalRunId = (ctx: any): string => resolveSessionScopedRunId(ctx);
  const goalRootDir = (ctx: any): string => defaultGoalStateRoot(ctx?.cwd || process.cwd());
  const notifyGoal = (ctx: any, message: string, level?: "info" | "error" | "success") => {
    if (ctx?.ui?.notify) ctx.ui.notify(message, level);
    else pi.sendUserMessage(message);
  };
  const nextGoalId = (state: GoalState): string => `goal-${state.goals.length + 1}`;
  const nextSubgoalId = (state: GoalState): string => `subgoal-${state.goals.reduce((count, goal) => count + goal.subgoals.length, 0) + 1}`;
  const targetTypeForId = (state: GoalState, targetId: string): "goal" | "subgoal" => {
    if (state.goals.some((goal) => goal.id === targetId)) return "goal";
    if (state.goals.some((goal) => goal.subgoals.some((subgoal) => subgoal.id === targetId))) return "subgoal";
    throw new Error(`Unknown goal target: ${targetId}`);
  };
  const refreshGoalFooterSummary = (state: GoalState) => {
    currentGoalFooterSummary = renderGoalSummary(state);
    currentGoalCompactionSummary = buildGoalCompactionSummary(state);
    for (const invalidate of goalFooterInvalidators) invalidate();
  };
  const applyGoalMutation = async (ctx: any, command: GoalCommand) => {
    const result = await applyAndPersistGoalCommand(goalRunId(ctx), goalRootDir(ctx), command, ctx);
    refreshGoalFooterSummary(result.state);
    return result.state;
  };
  const sendGoalContinuationFollowUp = async (prompt: string) => {
    try {
      await Promise.resolve(pi.sendUserMessage(prompt, { deliverAs: "followUp" }));
    } catch {
      await Promise.resolve(pi.sendUserMessage(prompt));
    }
  };
  const maybeQueueGoalContinuation = async (ctx: any, state: GoalState, receipt: ReturnType<typeof buildGoalVerifierReceipt>) => {
    const decision = planGoalContinuation(state, receipt, {
      isRootSession,
      isTeamWorker,
      subagentDepth: depthConfig.currentDepth,
    });
    if (decision.action === "none") return state;
    const queued = await applyGoalMutation(ctx, {
      type: "queue_continuation",
      targetType: decision.targetType,
      targetId: decision.targetId,
      reason: decision.reason,
      blockers: decision.blockers,
      leaseId: decision.leaseId,
    });
    await sendGoalContinuationFollowUp(decision.prompt);
    return queued;
  };
  const activeOrRunnableGoal = (state: GoalState) => state.goals.find((goal) => goal.id === state.activeGoalId)
    ?? state.goals.find((goal) => goal.status === "active" || goal.status === "blocked" || goal.status === "verifying")
    ?? state.goals.find((goal) => goal.status === "queued");
  const findGoalForContract = (state: GoalState, contract: ClarificationGoalContract) => state.goals.find((goal) =>
    goal.objective === contract.objective
    && goal.successCriteria.join("\n") === contract.successCriteria.join("\n")
    && goal.evidenceRequired.join("\n") === contract.evidenceRequired.join("\n")
  );
  const isHighRiskGoalContract = (contract: ClarificationGoalContract): boolean => {
    const haystack = [
      contract.objective,
      ...contract.scope,
      ...contract.nonGoals,
      ...contract.successCriteria,
      ...contract.constraints,
      ...contract.evidenceRequired,
      ...contract.risks,
      ...contract.suggestedSubgoals,
      contract.handoffCommand,
      contract.draftedAt,
    ].join("\n").toLowerCase();
    return /\b(delete|destructive|drop|wipe|remove data|production|migration|large[- ]scale|irreversible)\b/.test(haystack);
  };
  const buildGoalAutoPrompt = (state: GoalState): string => {
    const goal = activeOrRunnableGoal(state);
    const activeSubgoal = goal?.subgoals.find((subgoal) => subgoal.id === goal.activeSubgoalId || subgoal.status === "active" || subgoal.status === "blocked");
    const target = activeSubgoal ?? goal;
    const targetLabel = activeSubgoal ? `${activeSubgoal.id} (${activeSubgoal.title})` : goal ? `${goal.id} (${goal.title})` : "the current goal";
    return [
      "Continue the durable /goal runtime automatically.",
      "",
      `Target: ${targetLabel}`,
      target ? `Objective: ${target.objective}` : "Objective: inspect /goal status and infer the active target.",
      "",
      "Work until verifier PASS:",
      "1. Inspect /goal status.",
      "2. Implement the active goal or subgoal.",
      "3. Record concrete evidence with /goal evidence <targetId> <evidence>.",
      "4. Request completion with /goal complete <targetId>.",
      "5. If reviewer-verifier returns FAIL, address blockers, add new evidence, and request completion again.",
      "6. Stop only when reviewer-verifier returns PASS or user intervention is genuinely required.",
    ].join("\n");
  };
  const autoStartGoalRuntime = async (ctx: any, initialState: GoalState): Promise<GoalState> => {
    let state = initialState.continuation.queued || initialState.continuation.leaseId
      ? await applyGoalMutation(ctx, { type: "clear_continuation" })
      : initialState;
    let goal = activeOrRunnableGoal(state);

    if (!goal) {
      const clarificationRootDir = defaultClarificationStateRoot(ctx?.cwd || process.cwd());
      const clarification = await loadClarificationState(resolveSessionScopedRunId(ctx), clarificationRootDir);
      if (clarification.goalContract) {
        latestClarificationState = clarification;
        latestClarificationRootDir = clarificationRootDir;
      }
      const contract = clarification.goalContract ?? (latestClarificationRootDir === clarificationRootDir ? latestClarificationState?.goalContract : undefined);
      if (!contract) {
        currentPhase = "clarifying";
        await sendGoalContinuationFollowUp("The user ran /goal, but there is no active goal and no drafted Goal Contract. If the current conversation is clear enough, produce a Goal Contract and start the goal runtime; otherwise begin deep /clarify and ask one focused question.");
        return state;
      }

      if (isHighRiskGoalContract(contract)) {
        if (!ctx?.ui?.confirm) {
          notifyGoal(ctx, "High-risk Goal Contract requires interactive confirmation before /goal can start.", "error");
          return state;
        }
        const proceed = await ctx.ui.confirm("Start high-risk goal?", `This Goal Contract appears high-risk. Start it now?\n\n${contract.objective}`);
        if (!proceed) return state;
      }

      const existing = findGoalForContract(state, contract);
      if (existing) {
        goal = existing;
      } else {
        state = await applyGoalMutation(ctx, {
          type: "create_goal",
          goal: {
            id: nextGoalId(state),
            title: contract.objective,
            objective: contract.objective,
            successCriteria: contract.successCriteria,
            constraints: contract.constraints,
            evidenceRequired: contract.evidenceRequired,
          },
        });
        goal = state.goals.at(-1)!;
        for (const title of contract.suggestedSubgoals) {
          state = await applyGoalMutation(ctx, {
            type: "create_subgoal",
            subgoal: {
              id: nextSubgoalId(state),
              goalId: goal.id,
              title,
              objective: title,
            },
          });
        }
        goal = state.goals.find((candidate) => candidate.id === goal!.id)!;
      }
    }

    if (goal.status === "queued") {
      state = await applyGoalMutation(ctx, { type: "activate_goal", goalId: goal.id });
    }
    currentPhase = "goal_active";
    await sendGoalContinuationFollowUp(buildGoalAutoPrompt(state));
    return state;
  };
  const isNonTerminalGoalRun = (state: GoalState): boolean => {
    if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") return false;
    return Boolean(state.activeGoalId || state.goals.some((goal) => goal.status === "active" || goal.status === "blocked" || goal.status === "verifying"));
  };
  const isActiveClarificationRun = (state: ClarificationState): boolean => state.status === "interviewing" || state.status === "ready_for_contract" || state.status === "contract_drafted";
  const restoreLatestGoalState = async (ctx: any, events: ReturnType<typeof extractGoalStateReplayEventsFromSessionEntries>): Promise<GoalState> => {
    const rootDir = goalRootDir(ctx);
    const fallbackRunId = goalRunId(ctx);
    const runIds = [...new Set(events.map((event) => event.runId))];
    if (runIds.length === 0) {
      return (await restoreGoalStateFromSnapshotAndEvents(rootDir, fallbackRunId, events)).state;
    }

    const restored = await Promise.all(runIds.map(async (runId) => {
      const matchingEvents = events.filter((event) => event.runId === runId);
      const state = (await restoreGoalStateFromSnapshotAndEvents(rootDir, runId, matchingEvents)).state;
      const latestEventAt = matchingEvents.map((event) => event.createdAt).sort().at(-1) ?? state.updatedAt;
      return { state, latestEventAt };
    }));

    const candidates = restored.filter((item) => isNonTerminalGoalRun(item.state));
    return (candidates.length > 0 ? candidates : restored)
      .sort((left, right) => (right.state.updatedAt || right.latestEventAt).localeCompare(left.state.updatedAt || left.latestEventAt))[0].state;
  };
  const restoreLatestClarificationState = async (ctx: any, events: ReturnType<typeof extractClarificationStateReplayEventsFromSessionEntries>): Promise<ClarificationState> => {
    const rootDir = defaultClarificationStateRoot(ctx?.cwd || process.cwd());
    const fallbackRunId = resolveSessionScopedRunId(ctx);
    const runIds = [...new Set(events.map((event) => event.runId))];
    if (runIds.length === 0) {
      return (await restoreClarificationStateFromSnapshotAndEvents(rootDir, fallbackRunId, events)).state;
    }
    const restored = await Promise.all(runIds.map(async (runId) => {
      const matchingEvents = events.filter((event) => event.runId === runId);
      const state = (await restoreClarificationStateFromSnapshotAndEvents(rootDir, runId, matchingEvents)).state;
      const latestEventAt = matchingEvents.map((event) => event.createdAt).sort().at(-1) ?? state.updatedAt;
      return { state, latestEventAt };
    }));
    const candidates = restored.filter((item) => isActiveClarificationRun(item.state));
    return (candidates.length > 0 ? candidates : restored)
      .sort((left, right) => (right.state.updatedAt || right.latestEventAt).localeCompare(left.state.updatedAt || left.latestEventAt))[0].state;
  };

  const runGoalVerifier = async (
    ctx: any,
    state: GoalState,
    targetType: "goal" | "subgoal",
    targetId: string,
  ) => {
    const target = getGoalVerifierTarget(state, targetType, targetId);
    const agents = await discoverAgents(ctx?.cwd || process.cwd(), "user", BUNDLED_AGENTS_DIR);
    const verifierAgent = agents.find((agent) => agent.name === GOAL_VERIFIER_AGENT);
    const prompt = buildGoalVerifierPrompt(target, ctx?.cwd || process.cwd());
    const verifiedAt = new Date().toISOString();
    try {
      const result = await runAgent({
        agent: verifierAgent,
        agentName: GOAL_VERIFIER_AGENT,
        task: prompt,
        cwd: ctx?.cwd || process.cwd(),
        depthConfig,
        makeDetails: makeDetails("single"),
        contextMode: "fresh",
        sandbox: {
          enabled: true,
          workspaceRoot: ctx?.cwd || process.cwd(),
          networkMode: "on" as const,
          additionalWritableRoots: piWritableRoots,
          approvalMode: parsedApprovalMode.mode,
          requireApprovalForAllCommands: true,
        },
      });
      const output = isResultSuccess(result)
        ? getFinalOutput(result.messages)
        : result.errorMessage || result.stderr || getFinalOutput(result.messages) || "Verifier process failed";
      const parsed = parseGoalVerifierOutput(output);
      if (!isResultSuccess(result)) parsed.verdict = "FAIL";
      return buildGoalVerifierReceipt(target, parsed, {
        id: `receipt-${Date.now()}`,
        verifiedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildGoalVerifierReceipt(target, parseGoalVerifierOutput(message), {
        id: `receipt-${Date.now()}`,
        verifiedAt,
      });
    }
  };

  pi.registerCommand("goal", {
    description: "Auto-start or continue the durable goal runtime — use /clarify, then /goal",
    handler: async (args, ctx) => {
      const runId = goalRunId(ctx);
      const rootDir = goalRootDir(ctx);
      const parsed = parseGoalCommand(args || "");

      try {
        if (parsed.kind === "error") {
          notifyGoal(ctx, parsed.message, "error");
          return;
        }
        if (parsed.kind === "help") {
          notifyGoal(ctx, GOAL_HELP_TEXT, "info");
          return;
        }
        if (parsed.kind === "status") {
          const state = await loadGoalState(runId, rootDir);
          notifyGoal(ctx, renderGoalStatus(state), "info");
          return;
        }
        if (parsed.kind === "auto") {
          const state = await autoStartGoalRuntime(ctx, await loadGoalState(runId, rootDir));
          notifyGoal(ctx, renderGoalStatus(state), "success");
          return;
        }
        if (parsed.kind === "clear") {
          const result = await applyAndPersistGoalCommand(runId, rootDir, { type: "clear_state" }, ctx);
          currentPhase = "idle";
          activeArtifactDocument = null;
          currentGoalCompactionSummary = null;
          refreshGoalFooterSummary(result.state);
          notifyGoal(ctx, renderGoalStatus(result.state), "success");
          return;
        }

        let current = await loadGoalState(runId, rootDir);
        let state: GoalState;
        switch (parsed.kind) {
          case "create":
            state = await applyGoalMutation(ctx, {
              type: "create_goal",
              goal: {
                id: nextGoalId(current),
                title: parsed.objective,
                objective: parsed.objective,
              },
            });
            break;
          case "activate":
            state = await applyGoalMutation(ctx, { type: "activate_goal", goalId: parsed.goalId });
            break;
          case "subgoal":
            state = await applyGoalMutation(ctx, {
              type: "create_subgoal",
              subgoal: {
                id: nextSubgoalId(current),
                goalId: parsed.goalId,
                title: parsed.title,
                objective: parsed.title,
              },
            });
            break;
          case "evidence":
            state = await applyGoalMutation(ctx, {
              type: "add_evidence",
              targetType: targetTypeForId(current, parsed.targetId),
              targetId: parsed.targetId,
              evidence: parsed.evidence,
            });
            break;
          case "complete": {
            if (current.continuation.queued || current.continuation.leaseId) {
              current = await applyGoalMutation(ctx, { type: "clear_continuation" });
            }
            const targetType = targetTypeForId(current, parsed.targetId);
            const requested = await applyGoalMutation(ctx, {
              type: "request_completion",
              targetType,
              targetId: parsed.targetId,
            });
            const receipt = await runGoalVerifier(ctx, requested, targetType, parsed.targetId);
            const verified = await applyGoalMutation(ctx, {
              type: "record_verifier_result",
              receipt,
            });
            state = receipt.verdict === "PASS"
              ? await applyGoalMutation(ctx, {
                type: "complete_target",
                targetType,
                targetId: parsed.targetId,
              })
              : verified;
            state = await maybeQueueGoalContinuation(ctx, state, receipt);
            break;
          }
          case "pause":
            state = await applyGoalMutation(ctx, { type: "pause_goal", goalId: parsed.goalId });
            break;
          case "resume":
            state = await applyGoalMutation(ctx, { type: "resume_goal", goalId: parsed.goalId });
            break;
        }
        notifyGoal(ctx, renderGoalStatus(state!), "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notifyGoal(ctx, message, "error");
      }
    },
  });


  // Review target argument must be a PR number, a git ref name, or a PR URL.
  // Restrict to a safe character set (alphanumerics, dot, dash, underscore,
  // slash, colon) so that the value cannot smuggle shell metacharacters into
  // the downstream prompt's `gh pr diff ${topic}` / `git diff main...${topic}`
  // templates. Colon is safe (not a shell metacharacter) and is needed for the
  // `https://` scheme in GitHub PR URLs.
  const REVIEW_TOPIC_RE = /^[a-zA-Z0-9._/:\-]+$/;

  pi.registerCommand("review", {
    description:
      "Single-pass code review of current changes (PR or local diff, auto-detected)",
    handler: async (args, ctx) => {
      const topic = args?.trim() || "";
      if (topic && !REVIEW_TOPIC_RE.test(topic)) {
        ctx.ui.notify(
          `Invalid review target: "${topic}". Expected a PR number (e.g. 27), a branch name (e.g. feature/foo), or a PR URL (e.g. https://github.com/owner/repo/pull/27). Only alphanumerics, dot, dash, underscore, slash, and colon are allowed.`,
          "error"
        );
        return;
      }

      currentPhase = "reviewing";
      activeArtifactDocument = null;
      ctx.ui.setStatus("harness", "Code review in progress...");

      const targetClause = topic
        ? `Review target: "${topic}" (may be a PR number, a PR URL, or a branch name). If it is a number or contains "://" (a URL), treat it as a PR reference and fetch the diff with \`gh pr diff ${topic}\` — \`gh\` accepts PR numbers and full PR URLs interchangeably. Otherwise treat it as a branch name and diff it against main with \`git diff main...${topic}\`.`
        : `Review target: auto-detect. First run \`git rev-parse --abbrev-ref HEAD\` to get the current branch. Then run \`gh pr list --head <branch> --json number --jq '.[0].number'\` to check for a matching PR. If a PR exists, use \`gh pr diff <number>\`. Otherwise, combine \`git diff main...HEAD\` with uncommitted changes from \`git diff\` and \`git diff --cached\`.`;

      const prompt = [
        "You are an expert code reviewer. Perform a single-pass review of the current code changes.",
        "",
        targetClause,
        "",
        "If the diff is empty, report \"No changes to review\" and stop.",
        "",
        "Review the diff across these dimensions (brief, integrated review — do not produce a rubric):",
        "- **Bugs**: logic errors, boundary conditions, null/undefined, race conditions, missing error handling",
        "- **Security**: injection, auth/authz, crypto misuse, data exposure",
        "- **Performance**: unnecessary work, algorithmic complexity, sync I/O on hot paths",
        "- **Test coverage**: missing tests, happy-path only, uncovered edge cases",
        "- **Consistency**: naming/convention breaks, duplication of existing utilities, pattern drift",
        "",
        "Output the review directly to chat. Group findings by file. For each finding include: what, where (file:line), severity (Critical/High/Medium/Low), and a one-line suggested fix. Do NOT save to file. Do NOT dispatch subagents — this is a single-pass review performed by you directly.",
      ].join("\n");

      pi.sendUserMessage(prompt);
    },
  });

  if (isRootSession) {
    pi.registerCommand("ask", {
      description: "Manual smoke test for the ask_user_question tool",
      handler: async (args, ctx) => {
        const topic = args?.trim() || "Ask me one focused question using the ask_user_question tool.";
        const confirmed = await ctx.ui.confirm(
          "Run /ask",
          "The agent will send a manual prompt that requires one ask_user_question tool call.\n\nProceed?"
        );
        if (!confirmed) return;

        currentPhase = "idle";
        ctx.ui.setStatus("harness", "Manual ask_user_question test in progress...");

        pi.sendUserMessage(
          `Manual tool test: use the ask_user_question tool exactly once, then stop. User context: "${topic}"`
        );
      },
    });
  }

  const setupHandler = async (_args: string, ctx: any) => {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");

    let current: Record<string, unknown> = {};
    try {
      const raw = await readFile(settingsPath, "utf-8");
      current = JSON.parse(raw);
    } catch {
    }

    if (current.quietStartup === true) {
      ctx.ui.notify("Settings already configured — quietStartup is true.", "info");
      return;
    }

    const ok = await ctx.ui.confirm(
      "Setup: Configure Recommended Settings",
      [
        "This will add \"quietStartup\": true to your settings.json:",
        `  ${settingsPath}`,
        "",
        "This hides the default Skills/Extensions/Themes listing at startup.",
        "The ROACH PI banner takes over instead.",
        "",
        "Proceed?",
      ].join("\n"),
    );
    if (!ok) return;

    const updated = { ...current, quietStartup: true };
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(updated, null, 2) + "\n");

    ctx.ui.notify("Settings updated — quietStartup is now true. Restart pi to see the effect.", "info");

    try {
      const { execSync } = await import("child_process");
      execSync("gh auth status", { stdio: "pipe", timeout: 3000 });
      const star = await ctx.ui.confirm(
        "Star roach-pi on GitHub?",
        "Thanks for using ROACH PI! Would you like to star the repository? ⭐",
      );
      if (star) {
        execSync("gh api user/starred/tmdgusya/roach-pi -X PUT", { stdio: "pipe" });
        ctx.ui.notify("Thanks for the star! ⭐", "info");
      }
    } catch {
      // gh not available or not authenticated — skip silently
    }
  };

  pi.registerCommand("init", {
    description:
      "Configure recommended settings — sets quietStartup: true in ~/.pi/agent/settings.json",
    handler: setupHandler,
  });

  pi.registerCommand("setup", {
    description:
      "Configure recommended settings — sets quietStartup: true in ~/.pi/agent/settings.json",
    handler: setupHandler,
  });

  pi.registerCommand("reset-phase", {
    description: "Reset the workflow phase to idle (clears clarify/goal mode)",
    handler: async (_args, ctx) => {
      currentPhase = "idle";
      activeArtifactDocument = null;
      ctx.ui.setStatus("harness", undefined);
      ctx.ui.notify("Workflow phase reset to idle.", "info");
    },
  });

  registerWelcomeCommand(pi);
  registerEditorStashCommands(pi);

  pi.registerCommand("team", {
    description:
      "Kick off a lightweight native team run — usage: /team goal=\"...\" [agent=worker] [backend=auto|native|tmux] [worker-count=N] [worktree-policy=off|on|auto] [resume=runId] [resume-mode=mark-interrupted|retry-stale] [max-output=N]",
    getArgumentCompletions: async (argumentPrefix) => {
      try {
        return await getTeamArgumentCompletions(argumentPrefix, {
          listAgents: async () => {
            const found = await discoverAgents(process.cwd(), "user", BUNDLED_AGENTS_DIR);
            return found.map((a) => a.name);
          },
          listResumeRuns: async () => {
            const records = await listTeamRuns(defaultTeamRunStateRoot(process.cwd()));
            return records.map((r) => ({ runId: r.runId, status: r.status ?? "unknown" }));
          },
        });
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      if (process.env[PI_ENABLE_TEAM_MODE_ENV] !== "1") {
        ctx.ui.notify("team mode is disabled. Set PI_ENABLE_TEAM_MODE=1 to enable.", "error");
        return;
      }
      const parsed = parseTeamArgs(args ?? "");
      const isFollowUp = isTeamFollowUpCommand(parsed);
      if (!parsed.goal && !isFollowUp) {
        ctx.ui.notify("/team requires a goal, or follow-up mode: /team resume=<runId> command=<worker|taskId> message=\"...\"", "error");
        return;
      }
      if (parsed.goal && isFollowUp) {
        ctx.ui.notify("/team goal mode and follow-up command mode are mutually exclusive; omit goal when using resume+command+message.", "error");
        return;
      }
      const ok = await ctx.ui.confirm(
        isFollowUp ? "Enqueue Team Command" : "Start Team Run",
        isFollowUp
          ? `Enqueue follow-up command for ${parsed.commandTarget} in ${parsed.resume}:\n\n${parsed.commandMessage}\n\nProceed?`
          : `Dispatch a bounded team toward the goal:\n\n${parsed.goal}\n\nProceed?`,
      );
      if (!ok) return;
      ctx.ui.setStatus("harness", "Team run in progress...");
      pi.sendUserMessage(buildTeamCommandPrompt(parsed));
    },
  });

  async function persistStructuredSubagentTaskStatuses(
    ctx: any,
    args: unknown,
    taskIds: number[],
    status: "running" | "completed" | "failed",
  ): Promise<void> {
    if (taskIds.length === 0 || !harnessProgress?.hasState()) return;

    const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
    const latestEvent = extractHarnessReplayEventsFromSessionEntries(branchEntries).at(-1);
    const runId = latestEvent?.runId;
    const rootDir = latestEvent?.rootDir ?? harnessProgress?.getRunIdentity().rootDir ?? defaultHarnessStateRoot(ctx.cwd);
    if (!runId) return;

    await withHarnessStateMutationLock(runId, rootDir, async () => {
      const snapshotPath = harnessStateSnapshotPath(rootDir, runId);
      const snapshot = await readHarnessStateSnapshot(snapshotPath);
      if (!snapshot) return;

      const activePlan = selectStructuredPlanForPaths(snapshot.state, extractPlanPathsFromArgs(args));
      if (!activePlan) return;
      const validTaskIds = taskIds.filter((taskId) => activePlan.tasks.some((task) => task.id === taskId));
      if (validTaskIds.length === 0) return;

      const result = applyStructuredPlanTaskStatusUpdates(snapshot.state, {
        planId: activePlan.id,
        taskIds: validTaskIds,
        status,
        rootDir,
      });
      await writeHarnessStateSnapshot(snapshotPath, createHarnessStateSnapshot(result.state));
      for (const replayEvent of result.events) {
        (ctx.sessionManager as any)?.appendCustomEntry?.(HARNESS_STATE_EVENT_CUSTOM_TYPE, replayEvent);
      }
    });
    harnessProgress.invalidate();
  }

  (pi as any).on("message_end", async (event: any, ctx: any) => {
    const msg = event.message;
    if (msg.role === "assistant") {
      const usage = msg.usage;
      if (usage) {
        cacheStats.totalInput += usage.input;
        cacheStats.totalCacheRead += usage.cacheRead;
      }
      stopWorkingMessageShimmer();
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    activeTools.running.set(event.toolCallId, {
      name: event.toolName,
      intent: formatToolIntent(event.toolName, (event as any).intent),
      startedAt: Date.now(),
    } satisfies ActiveToolStatus);
    refreshWorkingMessageFromTools(ctx, activeTools);

    if (event.toolName === "subagent") {
      const args = getToolExecutionArgs(event, toolCallArgsById.get(event.toolCallId));
      if (args) {
        toolCallArgsById.set(event.toolCallId, args);
        const structuredTaskIds = extractExplicitPlanTaskIdsFromArgs(args);
        if (structuredTaskIds.length > 0) {
          planTaskIdsByToolCallId.set(event.toolCallId, structuredTaskIds);
          await persistStructuredSubagentTaskStatuses(ctx, args, structuredTaskIds, "running");
        }
      }
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    activeTools.running.delete(event.toolCallId);
    refreshWorkingMessageFromTools(ctx, activeTools);

    if (event.toolName === "subagent") {
      const args = getToolExecutionArgs(event, toolCallArgsById.get(event.toolCallId));
      if (args) {
        const matchedTaskIds = planTaskIdsByToolCallId.get(event.toolCallId);
        const success = !(event.isError ?? false);
        const hasValidator = subagentItemRecords(args).some((item) => item.agent === "plan-validator");
        const structuredTaskIds = matchedTaskIds && matchedTaskIds.length > 0 ? matchedTaskIds : extractExplicitPlanTaskIdsFromArgs(args);
        if (structuredTaskIds.length > 0) {
          const taskStatus = success ? "completed" : "failed";
          await persistStructuredSubagentTaskStatuses(ctx, args, structuredTaskIds, taskStatus);
        }
      }
    }

    toolCallArgsById.delete(event.toolCallId);
    planTaskIdsByToolCallId.delete(event.toolCallId);
  });

  pi.on("session_start", async (_event, ctx) => {
    preferTodoSurfaceTools(pi);
    currentPhase = "idle";
    activeArtifactDocument = null;
    clarificationDone = false;
    currentClarificationCompactionSummary = null;
    latestClarificationState = null;
    latestClarificationRootDir = null;

    cacheStats.totalInput = 0;
    cacheStats.totalCacheRead = 0;
    activeTools.running.clear();
    stopWorkingMessageShimmer();
    toolCallArgsById.clear();
    planTaskIdsByToolCallId.clear();
    const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];

    // Restore simple todo state from session branch entries
    restoreTodosFromBranchEntries(branchEntries);

    const goalEvents = extractGoalStateReplayEventsFromSessionEntries(branchEntries);
    const goalRestoreRootDir = goalRootDir(ctx);
    const restoredGoalState = await restoreLatestGoalState(ctx, goalEvents);
    await persistGoalState(restoredGoalState, goalRestoreRootDir);
    if (isNonTerminalGoalRun(restoredGoalState)) currentPhase = "goal_active";
    currentGoalFooterSummary = renderGoalSummary(restoredGoalState);
    currentGoalCompactionSummary = buildGoalCompactionSummary(restoredGoalState);

    const clarificationEvents = extractClarificationStateReplayEventsFromSessionEntries(branchEntries);
    const clarificationRestoreRootDir = defaultClarificationStateRoot(ctx.cwd);
    const restoredClarificationState = await restoreLatestClarificationState(ctx, clarificationEvents);
    await persistClarificationState(restoredClarificationState, clarificationRestoreRootDir);
    if (!isNonTerminalGoalRun(restoredGoalState) && isActiveClarificationRun(restoredClarificationState)) currentPhase = "clarifying";
    latestClarificationState = restoredClarificationState;
    latestClarificationRootDir = clarificationRestoreRootDir;
    currentClarificationCompactionSummary = buildClarificationCompactionSummary(restoredClarificationState);

    // --- Structured-first session restore (M6) ---
    // Detect structured state via validated HARNESS_STATE_EVENT_CUSTOM_TYPE entries.
    // If structured state exists, use it as the primary restore path.
    // Otherwise, fall back to legacy parser-derived reconstruction.
    let structuredRestore: { rootDir: string; state: HarnessState } | null = null;
    const harnessEvents = extractHarnessReplayEventsFromSessionEntries(branchEntries);
    const latestHarnessEvent = harnessEvents.at(-1);
    const structuredRunId = latestHarnessEvent?.runId;

    if (structuredRunId) {
      // Primary path: load snapshot + replay structured events
      const defaultRootDir = defaultHarnessStateRoot(ctx.cwd);
      const rootDir = latestHarnessEvent?.rootDir ?? defaultRootDir;
      const snapshot = await readHarnessStateSnapshot(harnessStateSnapshotPath(rootDir, structuredRunId));
      const matchingEvents = harnessEvents.filter((event) =>
        event.runId === structuredRunId && (event.rootDir ?? defaultRootDir) === rootDir
      );
      const reconstructedState = restoreHarnessStateFromSnapshotAndEvents(
        snapshot,
        createHarnessState({ runId: structuredRunId, title: structuredRunId }),
        matchingEvents,
      );
      await writeHarnessStateSnapshot(
        harnessStateSnapshotPath(rootDir, structuredRunId),
        createHarnessStateSnapshot(reconstructedState),
      );
      structuredRestore = { rootDir, state: reconstructedState };
    }

    showWelcomeHeader(ctx.ui);

    const uiSettings = resolveAgenticUiSettings({ cwd: ctx.cwd });

    harnessProgress = new HarnessProgressProvider();
    if (structuredRestore) {
      harnessProgress.hydrate(structuredRestore.state, structuredRestore.rootDir);
    } else if (latestHarnessEvent?.runId) {
      harnessProgress.setRun(latestHarnessEvent.runId, latestHarnessEvent.rootDir);
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      let gitStats: GitStats = { ahead: 0, behind: 0, dirty: 0, untracked: 0 };

      async function refreshGitStats() {
        gitStats = await computeGitStats(ctx.cwd);
        tui.requestRender();
      }

      const gitTimer = setInterval(refreshGitStats, 5000);
      refreshGitStats();
      const unsubBranch = footerData.onBranchChange(() => refreshGitStats());

      const footer = new RoachFooter(theme, footerData, {
        cwd: ctx.cwd,
        getModelName: () => ctx.model?.name,
        getContextUsage: () => ctx.getContextUsage(),
        getGitStats: () => gitStats,
        getThinkingLevel: () => undefined,
        getModelInfo: () => getModelInfo(ctx),
      }, cacheStats, activeTools, tui, {
        preset: uiSettings.footerPreset,
        glyphs: uiSettings.footerGlyphs,
        getGoalSummary: () => currentGoalFooterSummary,
      });

      const invalidateGoalFooter = () => footer.invalidate();
      goalFooterInvalidators.add(invalidateGoalFooter);

      const originalDispose = footer.dispose.bind(footer);
      footer.dispose = () => {
        goalFooterInvalidators.delete(invalidateGoalFooter);
        originalDispose();
        clearInterval(gitTimer);
        unsubBranch();
      };

      return footer;
    });

    installEditorComposition(ctx.ui as any, {
      getBorderContext: () => {
        const usage = ctx.getContextUsage();
        return {
          modelName: ctx.model?.name ?? "unknown",
          thinkingLevel: "off" as const,
          cwd: ctx.cwd,
          gitBranch: null,
          gitDirty: false,
          contextPercent: usage?.percent ?? 0,
          contextWindow: usage?.contextWindow ?? 0,
        };
      },
    });

    ctx.ui.notify(
      "Agentic Harness loaded: /clarify, /goal, /reset-phase",
      "info"
    );
  });
}
