import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import { RoachFooter, type CacheStats, type ActiveTools } from "./footer.js";
import { resolveAgenticUiSettings } from "./ui-settings.js";
import { registerWelcomeCommand, showWelcomeHeader } from "./welcome-ui.js";
import { registerEditorStashCommands } from "./editor-stash.js";
import { installEditorComposition } from "./editor-composition.js";
import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { discoverAgents, type SubagentContextMode } from "./agents.js";
import { runAgent, mapWithConcurrencyLimit, MAX_CONCURRENCY, MAX_PARALLEL_TASKS, resolveDepthConfig, getCycleViolations, spawnAsync } from "./subagent.js";
import { emptyUsage, isResultError, isResultSuccess, getResultSummaryText, type AsyncDependency, type AsyncRunRecord, type SingleResult, type SubagentDetails } from "./types.js";
import { renderCall, renderResult } from "./render.js";
import { parsePlan } from "./plan-parser.js";
import { buildValidatorPrompt } from "./validator-template.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { microcompactMessages, getCompactionPrompt, formatCompactSummary } from "./compaction.js";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { isDisciplineAgent, augmentAgentWithKarpathy } from "./discipline.js";
import { PlanProgressTracker } from "./plan-progress.js";
import { MilestoneTracker, extractMilestoneId } from "./milestone-tracker.js";
import { isCompletionFilePath } from "./legacy-import-markdown.js";
import type { MilestoneStatus } from "./milestone-tracker.js";
import { WorkingVisibilityController } from "./working-visibility.js";
import {
  completePlanSubagentTasks,
  detectMilestonesFromToolResult,
  extractMilestonePathsFromArgs,
  extractPlanPathsFromArgs,
  getToolExecutionArgs,
  startMilestonesFromSubagentArgs,
  loadMilestonesFromAssistantMessage,
  loadPlanFromAssistantMessageEnd,
  loadPlanFromToolResultEvent,
  reconstructMilestoneProgressFromSessionEntries,
  reconstructPlanProgressFromSessionEntries,
  reloadPlanFromSubagentArgs,
  startPlanSubagentTasks,
  subagentItemRecords,
} from "./legacy-import-markdown.js";
import {
  defaultHarnessStateRoot,
  harnessStateSnapshotPath,
  readHarnessStateSnapshot,
  writeHarnessStateSnapshot,
  createHarnessStateSnapshot,
} from "./harness-storage.js";
import { replayHarnessEvents, HARNESS_STATE_EVENT_CUSTOM_TYPE } from "./harness-events.js";
import { createHarnessState } from "./harness-state.js";
import { fetchUrlToMarkdown } from "./webfetch/utils.js";
import { PI_ENABLE_TEAM_MODE_ENV, PI_TEAM_WORKER_ENV, cleanupActiveTeamTmuxResources, formatTeamRunSummary, runTeam, type TeamBackend, type TeamRunSummary } from "./team.js";
import { defaultTeamRunStateRoot, listTeamRuns, readTeamRunRecord, writeTeamRunRecord, type StaleTaskResumeMode } from "./team-state.js";
import { getDefaultRegistry } from "./async-registry.js";
import { buildTeamCommandPrompt, getTeamArgumentCompletions, isTeamFollowUpCommand, parseTeamArgs } from "./team-command.js";
import { renderWebfetchCall, renderWebfetchResult } from "./webfetch/render.js";
import { registerHarnessTools } from "./harness-tools.js";
import { HarnessProgressProvider } from "./harness-progress.js";
import { applyStructuredPlanTaskStatusUpdates, selectStructuredPlanForPaths } from "./harness-runtime-progress.js";
import { getDefaultApprovalStore } from "./sandbox/approval-store.js";
import { parseSandboxApprovalMode } from "./sandbox/approval-mode.js";
import { createSandboxedBashOperations } from "./sandbox/bash-operations.js";
import { resolvePiAgentDir, resolvePiSessionDir } from "./sandbox/agent-dir.js";
import { makePolicyFingerprint } from "./sandbox/policy-engine.js";
import { isSensitiveEnvPath } from "./sandbox/sensitive-env.js";
import { execFile } from "child_process";
import { promisify } from "util";
import type { GitStats, ModelInfo } from "./footer.js";

const execFileAsync = promisify(execFile);

type WorkflowPhase =
  | "idle"
  | "clarifying"
  | "planning"
  | "ultraplanning"
  | "reviewing"
  | "ultrareviewing";

let currentPhase: WorkflowPhase = "idle";
let activeGoalDocument: string | null = null;
let clarificationDone: boolean = false;

const cacheStats: CacheStats = { totalInput: 0, totalCacheRead: 0 };
const activeTools: ActiveTools = { running: new Map() };
const planProgress = new PlanProgressTracker();
const milestoneTracker = new MilestoneTracker();

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

const PLAN_PROGRESS_CUSTOM_TYPE = "plan-progress";
const MILESTONE_PROGRESS_CUSTOM_TYPE = "milestone-progress";

function persistProgressSnapshot(ctx: { sessionManager?: any }): void {
  if (planProgress.hasPlan()) {
    ctx.sessionManager?.appendCustomEntry?.(PLAN_PROGRESS_CUSTOM_TYPE, {
      taskStatuses: planProgress.getTaskStatuses(),
    });
  }
  if (milestoneTracker.hasMilestones()) {
    const active = milestoneTracker.getActiveMilestone();
    ctx.sessionManager?.appendCustomEntry?.(MILESTONE_PROGRESS_CUSTOM_TYPE, {
      milestoneStatuses: milestoneTracker.getMilestoneStatuses(),
      activeTasks: active?.tasks ?? null,
      activeMilestoneId: active?.id ?? null,
    });
  }
}

const MICROCOMPACTION_ENV = "PI_AGENTIC_MICROCOMPACTION";

function isMicrocompactionEnabled(): boolean {
  return process.env[MICROCOMPACTION_ENV] === "1";
}

// Track tool call arguments by toolCallId so we can correlate plan-task
// subagent starts/completions across tool_execution_start/end events.
const toolCallArgsById = new Map<string, Record<string, unknown>>();
const planTaskIdsByToolCallId = new Map<string, number[]>();

const sessionPlanPaths = new Set<string>();
let workingVisibility: WorkingVisibilityController | null = null;
let harnessProgress: HarnessProgressProvider | null = null;

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
      const sandboxedBashOperations = createSandboxedBashOperations(createRootSandbox());
      const localBash = createBashTool(process.cwd(), { operations: sandboxedBashOperations });
      pi.registerTool({
        ...localBash,
        label: "bash (sandboxed)",
      });
      pi.on("user_bash", (_event, ctx) => ({
        operations: createSandboxedBashOperations(createRootSandbox(ctx as any, true)),
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
    async: Type.Optional(Type.Boolean({ description: "Execute in background, return runId immediately. Only works with single mode (agent + task)." })),
    asyncDependency: Type.Optional(stringEnum(["background", "needed-before-final"], {
      description: 'Agent-declared dependency for async:true runs. Use "needed-before-final" when the lead must wait for this answer before finalizing.',
    })),
    action: Type.Optional(stringEnum(["status", "interrupt", "wait", "mark-background"], {
      description: 'Run management action. "status" lists or inspects runs; "interrupt" stops a run; "wait" blocks until a run completes and returns its result; "mark-background" explicitly marks a run as not needed for the final response.',
    })),
    id: Type.Optional(Type.String({ description: "Run ID for status/interrupt/wait/mark-background actions." })),
    waitTimeoutMs: Type.Optional(Type.Number({ description: "Maximum milliseconds for action:\"wait\" before returning a timeout. Default 600000. Set 0 to wait indefinitely." })),
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
    async?: boolean;
    asyncDependency?: AsyncDependency;
    action?: "status" | "interrupt" | "wait" | "mark-background";
    id?: string;
    waitTimeoutMs?: number;
  };

  const makeDetails = (mode: "single" | "parallel") => (results: SingleResult[]): SubagentDetails => ({ mode, results });

  const isAsyncRunBlockingFinal = (record: AsyncRunRecord): boolean =>
    (record.status === "spawning" || record.status === "running") && record.dependency !== "background";

  const formatAsyncGuardRun = (record: AsyncRunRecord): string => {
    const elapsed = Math.round(record.progress.elapsedMs / 1000);
    const dependency = record.dependency ?? "unclassified";
    const task = record.task.replace(/\s+/g, " ").slice(0, 100);
    return `- ${record.runId} [${record.status}/${dependency}] ${record.agent}: ${task}${record.task.length > 100 ? "..." : ""} (${elapsed}s)`;
  };

  const buildAsyncFinalGuardText = (records: AsyncRunRecord[]): string => [
    "⛔ Async subagent final-response guard",
    "",
    "A final assistant response was blocked because async subagent runs are still active and have not been explicitly marked as background.",
    "Before finalizing, choose one action for each run:",
    "- `subagent` with `action:\"wait\"` and `id` to join and retrieve the result.",
    "- `subagent` with `action:\"status\"` and `id` to inspect progress/result.",
    "- `subagent` with `action:\"interrupt\"` and `id` to stop it.",
    "- `subagent` with `action:\"mark-background\"` and `id` only if the final response does not depend on it.",
    "",
    "Active blocking async runs:",
    ...records.map(formatAsyncGuardRun),
  ].join("\n");

  const hasToolCallContent = (message: any): boolean =>
    Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "toolCall");

  const replaceAssistantMessageText = (message: any, text: string): any => ({
    ...message,
    content: [{ type: "text", text }],
    stopReason: message?.stopReason === "toolUse" ? message.stopReason : "stop",
  });

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
        "ONLY use these exact agent names — do NOT invent or guess agent names: explorer, worker, planner, plan-worker, plan-validator, plan-compliance, reviewer-feasibility, reviewer-architecture, reviewer-risk, reviewer-bug, reviewer-security, reviewer-performance, reviewer-test-coverage, reviewer-consistency, reviewer-verifier, review-synthesis.",
        "All agents use the default model. Do NOT specify or mention specific models (no Haiku, Sonnet, etc.).",
        "For codebase exploration: use 'explorer'. For general execution: use 'worker'. For plan execution: use 'plan-compliance' → 'plan-worker' → 'plan-validator'.",
        "Use async:true only when the lead can safely continue. If the subagent answer is needed before the final response, set asyncDependency:'needed-before-final' and later call action:'wait' with the returned run id. Unclassified async runs also block final responses until resolved.",
        "Async starts return a run id and durable output file path when available; use action:'wait' to join rather than guessing. Use action:'status' for inspection, action:'interrupt' to stop a running async run, and action:'mark-background' only when you explicitly choose to finalize without that run's result.",
        "For ultraplan milestone reviews: dispatch all 3 reviewers in parallel: reviewer-feasibility, reviewer-architecture, reviewer-risk.",
        "For ultrareview code reviews: dispatch 10 tasks in parallel (5 reviewers × 2 seeds): reviewer-bug, reviewer-security, reviewer-performance, reviewer-test-coverage, reviewer-consistency. Then run reviewer-verifier on the aggregated findings, then review-synthesis on the verified result.",
        "Max 12 parallel tasks with 10 concurrent. Chain mode stops on first error.",
        "When calling plan-validator, ALWAYS provide planFile (path to the plan .md file) and planTaskId (the task number to validate). The validator prompt will be built from the plan file automatically — you do not need to compose it. Example: { agent: 'plan-validator', task: 'validate', planFile: 'docs/.../plan.md', planTaskId: 3 }",
      ],
      parameters: SubagentParams,

      renderCall: (args, theme) => renderCall(args, theme),
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
            const parsed = parsePlan(planContent);
            const planTask = parsed.tasks.find((t) => t.id === planTaskId);
            return planTask ? buildValidatorPrompt(planTask, parsed.verificationCommand) : taskText;
          } catch {
            return taskText;
          }
        };

        if (params.action) {
          const registry = getDefaultRegistry();
          if (params.action === "status") {
            if (params.id) {
              const record = registry.getStatus(params.id);
              if (!record) {
                return {
                  content: [{ type: "text" as const, text: `No run found with id: ${params.id}` }],
                  details: undefined,
                };
              }
              const statusText = [
                `Run: ${record.runId}`,
                `Agent: ${record.agent}`,
                `Task: ${record.task}`,
                `Status: ${record.status}`,
                record.dependency ? `Dependency: ${record.dependency}` : null,
                `Backend: ${record.backend}`,
                record.outputFile ? `Output file: ${record.outputFile}` : null,
                record.pid ? `PID: ${record.pid}` : null,
                `Elapsed: ${Math.round(record.progress.elapsedMs / 1000)}s`,
                record.progress.lastActivity ? `Last tool: ${record.progress.lastActivity.name}` : null,
                `Tokens: in=${record.progress.usage.input} out=${record.progress.usage.output}`,
                record.result ? `Exit code: ${record.result.exitCode}` : null,
                record.result ? `Result:\n${getResultSummaryText(record.result, maxOutput)}` : null,
              ].filter(Boolean).join("\n");
              return {
                content: [{ type: "text" as const, text: statusText }],
                details: undefined,
              };
            }
            const runs = registry.listActive();
            if (runs.length === 0) {
              return {
                content: [{ type: "text" as const, text: "No active async runs." }],
                details: undefined,
              };
            }
            const statusText = runs.map(r =>
              `${r.runId} [${r.status}${r.dependency ? `/${r.dependency}` : ""}] ${r.agent}: ${r.task.slice(0, 60)}${r.task.length > 60 ? "..." : ""} (${Math.round(r.progress.elapsedMs / 1000)}s)`
            ).join("\n");
            return {
              content: [{ type: "text" as const, text: `Active runs (${runs.length}):\n${statusText}` }],
              details: undefined,
            };
          }
          if (params.action === "mark-background") {
            if (!params.id) {
              return {
                content: [{ type: "text" as const, text: "Error: mark-background action requires id parameter." }],
                details: undefined,
                isError: true,
              };
            }
            const success = registry.setDependency(params.id, "background");
            if (!success) {
              return {
                content: [{ type: "text" as const, text: `No run found with id: ${params.id}` }],
                details: undefined,
                isError: true,
              };
            }
            const record = registry.getStatus(params.id);
            return {
              content: [{ type: "text" as const, text: `Run ${params.id} marked as background. It will no longer block final assistant responses.` }],
              details: record ? { ...makeDetails("single")([]), asyncRun: record } : undefined,
            };
          }
          if (params.action === "interrupt") {
            if (!params.id) {
              return {
                content: [{ type: "text" as const, text: "Error: interrupt action requires id parameter." }],
                details: undefined,
                isError: true,
              };
            }
            const success = registry.interrupt(params.id);
            if (!success) {
              return {
                content: [{ type: "text" as const, text: `Failed to interrupt run ${params.id}. Run not found or not in a running state.` }],
                details: undefined,
                isError: true,
              };
            }
            return {
              content: [{ type: "text" as const, text: `Interrupt signal sent to run ${params.id}.` }],
              details: undefined,
            };
          }
          if (params.action === "wait") {
            if (!params.id) {
              return {
                content: [{ type: "text" as const, text: "Error: wait action requires id parameter." }],
                details: undefined,
                isError: true,
              };
            }
            const waitTimeoutMs = params.waitTimeoutMs ?? 600_000;
            const { record, timedOut } = await registry.waitForCompletion(params.id, waitTimeoutMs);
            if (!record) {
              return {
                content: [{ type: "text" as const, text: `No run found with id: ${params.id}` }],
                details: undefined,
                isError: true,
              };
            }
            if (timedOut) {
              return {
                content: [{ type: "text" as const, text: `Timed out waiting for run ${record.runId}. Current status: ${record.status}.` }],
                details: { ...makeDetails("single")([]), asyncRun: record },
                isError: true,
              };
            }
            if (!record.result) {
              const failed = record.status !== "completed";
              registry.markConsumed(record.runId);
              return {
                content: [{ type: "text" as const, text: `Run ${record.runId} finished with status ${record.status} and no captured result.` }],
                details: { ...makeDetails("single")([]), asyncRun: record },
                isError: failed,
              };
            }
            registry.markConsumed(record.runId);
            const failed = isResultError(record.result);
            return {
              content: [{ type: "text" as const, text: getResultSummaryText(record.result, maxOutput) }],
              details: { ...makeDetails("single")([record.result]), asyncRun: record },
              isError: failed || undefined,
            };
          }
        }

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
          if (params.async && (params.tasks || params.chain)) {
            return {
              content: [{ type: "text" as const, text: "Error: async mode only works with single mode (agent + task). Cannot combine with tasks or chain." }],
              details: makeDetails("single")([]),
              isError: true,
            };
          }

          const effectiveTask = await effectiveTaskFor(agent, task, params.planFile, params.planTaskId);

          if (params.async) {
            const asyncAgent = isDisciplineAgent(agent)
              ? augmentAgentWithKarpathy(findAgent(agent))
              : findAgent(agent);
            const registry = getDefaultRegistry();
            const { runId } = await spawnAsync({
              agent: asyncAgent,
              agentName: agent,
              task: effectiveTask,
              cwd: cwd || defaultCwd,
              depthConfig,
              sandbox: sandboxFor(cwd || defaultCwd),
              makeDetails: makeDetails("single"),
              maxOutput,
              output,
              reads,
              progress,
              contextMode: context,
            }, registry, params.asyncDependency);
            const dependencyText = params.asyncDependency === "background"
              ? "\nDependency: background. This run will not block final assistant responses."
              : params.asyncDependency === "needed-before-final"
                ? "\nDependency: needed-before-final. Call subagent action:\"wait\" with this run id before finalizing dependent work."
                : "\nDependency: unclassified. Final assistant responses will be blocked until this run completes, is interrupted, or is explicitly marked with action:\"mark-background\".";
            return {
              content: [{ type: "text" as const, text: `Async run started: ${runId}${dependencyText}` }],
              details: {
                ...makeDetails("single")([{
                  agent,
                  agentSource: "unknown" as const,
                  task: effectiveTask,
                  exitCode: 0,
                  messages: [],
                  stderr: "",
                  usage: emptyUsage(),
                  asyncRunId: runId,
                }]),
                asyncRun: registry.getStatus(runId),
              },
            };
          }

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

  pi.on("session_shutdown", async (_event, _ctx) => {
    workingVisibility?.restore();
    workingVisibility = null;
    sessionPlanPaths.clear();
    harnessProgress = null;
    getDefaultRegistry().abortAll();
    await cleanupActiveTeamTmuxResources();
  });

  const registry = getDefaultRegistry();
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

  pi.on("resources_discover", async (_event, _ctx) => {
    return {
      skillPaths: [BUNDLED_SKILLS_DIR],
    };
  });

  const clarificationQuestionRule = isRootSession
    ? "- Ask ONE question per message using the ask_user_question tool."
    : "- Do not ask the user questions directly. If information is missing, state the gap clearly in your output.";
  const planningAmbiguityRule = isRootSession
    ? "- Use ask_user_question if you need to resolve any remaining ambiguity."
    : "- If ambiguity remains, state it explicitly and request root-session clarification in your output.";
  const ultraplanningTradeoffRule = isRootSession
    ? "- Use ask_user_question if you need user input on trade-offs."
    : "- If trade-off input is missing, document the trade-off and recommend what should be clarified by the root session.";

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
      "\n\n## Active Workflow: Clarification",
      "You are in agentic-clarification mode. Follow the agentic-clarification skill rules strictly:",
      clarificationQuestionRule,
      "- Generate questions and choices dynamically based on context — no predefined templates.",
      "- Use the subagent tool with agent 'explorer' to investigate the codebase in parallel with user Q&A.",
      "- After each answer, update 'what we've established so far' and assess remaining ambiguity.",
      "- When ambiguity is resolved, present a Context Brief with Complexity Assessment.",
      "- Do NOT start implementation. This phase ends with a Context Brief, not code.",
    ].join("\n"),
    planning: [
      "\n\n## Active Workflow: Plan Crafting",
      "You are in agentic-plan-crafting mode. Follow the agentic-plan-crafting skill rules strictly:",
      "- Write an executable implementation plan from the current context.",
      "- Every step must be executable — no placeholders.",
      planningAmbiguityRule,
      "- End with a Self-Review before presenting the plan.",
    ].join("\n"),
    ultraplanning: [
      "\n\n## Active Workflow: Milestone Planning (Ultraplan)",
      "You are in agentic-milestone-planning mode. Follow the agentic-milestone-planning skill rules strictly:",
      "- Compose a Problem Brief from the current context.",
      "- Dispatch all 3 reviewer agents in parallel using the subagent tool's parallel mode: reviewer-feasibility, reviewer-architecture, reviewer-risk.",
      "- Synthesize all reviewer findings into a milestone DAG.",
      ultraplanningTradeoffRule,
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
    ultrareviewing: [
      "\n\n## Active Workflow: Deep Code Review (/ultrareview)",
      "You are orchestrating a 3-stage code review pipeline:",
      "- Stage 1 (finding): dispatch 10 subagents in parallel using the subagent tool's parallel mode — 5 reviewer roles (reviewer-bug, reviewer-security, reviewer-performance, reviewer-test-coverage, reviewer-consistency) × 2 seeds each. Seed 2 must be instructed to focus on findings seed 1 might miss.",
      "- Stage 2 (verification): dispatch reviewer-verifier (single mode) on the aggregated per-role findings.",
      "- Stage 3 (synthesis): dispatch review-synthesis (single mode) on the verifier output.",
      "- Save the synthesis output to docs/engineering-discipline/reviews/<YYYY-MM-DD>-<topic>-review.md and stream a 5-item top-priority summary to chat.",
      "- If the diff is empty, report 'No changes to review' and stop before dispatching any subagents.",
      "- NEVER dispatch any agent whose name contains 'worker' — only reviewer-* and review-synthesis are allowed in this pipeline.",
    ].join("\n"),
  };

  // Matches user turns that are claude-code skill/command invocations. We suppress
  // phase guidance for these turns so the invoked skill's own instructions are not
  // overridden by a stale workflow phase (e.g. user ran /ultraplan last week,
  // never reset-phase, and today invokes /systematic-debugging).
  const SKILL_INVOCATION_RE = /<command-name>|<command-message>|\[skill\]/;

  pi.on("before_agent_start", async (event, _ctx) => {
    const isSkillInvocation = SKILL_INVOCATION_RE.test(event.prompt ?? "");
    const phaseGuidance = (isRootSession && !isSkillInvocation) ? PHASE_GUIDANCE[currentPhase] : "";
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

    const blockingAsyncRuns = getDefaultRegistry().listActive().filter(isAsyncRunBlockingFinal);
    const asyncGuidance = blockingAsyncRuns.length > 0
      ? `\n\n## Active Async Subagent Guard\nYou have active async subagent runs that block final responses until resolved or explicitly marked as background. Before giving a final answer, call the subagent tool with action:\"wait\", action:\"status\", action:\"interrupt\", or action:\"mark-background\" for each blocking run.\n\n${blockingAsyncRuns.map(formatAsyncGuardRun).join("\n")}`
      : "";

    const combined = phaseGuidance + idleGuidance + asyncGuidance;
    if (!combined && !delegationInfo) return;
    return {
      systemPrompt: event.systemPrompt + combined + delegationInfo,
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
    // Skip custom compaction for idle phase with no active goal document —
    // let pi's default compaction handle simple conversations.
    if (currentPhase === "idle" && !activeGoalDocument) return;

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
      activeGoalDocument,
      event.customInstructions,
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
            activeGoalDocument,
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
        activeGoalDocument?: string | null;
        clarificationDone?: boolean;
      };
      if (details.phase) currentPhase = details.phase as WorkflowPhase;
      if (details.activeGoalDocument !== undefined) {
        activeGoalDocument = details.activeGoalDocument;
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
    planning: /^docs\/engineering-discipline\/plans\//,
    ultraplanning: /^docs\/engineering-discipline\/plans\//,
    reviewing: /^docs\/engineering-discipline\/reviews\//,
    ultrareviewing: /^docs\/engineering-discipline\/reviews\//,
  };

  pi.on("tool_result", async (event, ctx) => {
    const toolName = event.toolName;

    // LEGACY PATH — parser-derived plan/milestone loading.
    // Skip when structured state exists; harness tools handle updates directly.
    if (!harnessProgress?.hasState()) {
      if (toolName === "read" || toolName === "write") {
        await loadPlanFromToolResultEvent(planProgress, {
          toolName,
          input: event.input as Record<string, unknown> | undefined,
          content: event.content,
        }, ctx.cwd, sessionPlanPaths);
      }

      if (toolName === "read" || toolName === "write" || toolName === "edit") {
        const detected = await detectMilestonesFromToolResult(milestoneTracker, {
          toolName,
          input: event.input as Record<string, unknown> | undefined,
          content: event.content,
        }, ctx.cwd);
        const input = event.input as Record<string, unknown> | undefined;
        const filePath = typeof input?.path === "string"
          ? input.path
          : typeof input?.file_path === "string"
            ? input.file_path
            : "";
        if (detected && isCompletionFilePath(filePath)) {
          planProgress.clear();
          persistProgressSnapshot(ctx);
        }
      }
    }

    if (toolName === "harness_milestone" || toolName === "harness_plan" || toolName === "harness_todo") {
      const input = event.input as Record<string, unknown> | undefined;
      const runId = typeof input?.runId === "string" ? input.runId : undefined;
      if (runId) {
        if (!harnessProgress) {
          harnessProgress = new HarnessProgressProvider();
        }
        if (!harnessProgress.hasState()) {
          harnessProgress.setRunId(runId);
        } else {
          harnessProgress.invalidate();
        }
      }
    }

    if (currentPhase === "idle") return;

    if (toolName !== "write" && toolName !== "edit") return;

    const filePath = event.input.path as string | undefined;
    if (!filePath) return;

    const relativePath = filePath.replace(/^.*?docs\/engineering-discipline\//, "docs/engineering-discipline/");
    if (!GOAL_DOC_PATTERN.test(relativePath)) return;

    activeGoalDocument = relativePath;

    // Auto-reset phase when the current phase's terminal artifact is written (not edited).
    // Clear activeGoalDocument too so this matches /reset-phase semantics — otherwise the
    // session_before_compact early-return gate stays open with a stale goal-doc pointer.
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
        "Start Clarification",
        "The agent will ask you questions one at a time to clarify your request.\nIt will also explore the codebase in parallel.\n\nProceed?"
      );
      if (!start) return;

      currentPhase = "clarifying";
      activeGoalDocument = null;
      ctx.ui.setStatus("harness", "Clarification in progress...");

      const prompt = topic
        ? isRootSession
          ? `The user wants to clarify the following request: "${topic}"\n\nBegin the agentic-clarification process. Follow the agentic-clarification skill rules. Ask ONE question using the ask_user_question tool. Use the subagent tool with agent 'explorer' to investigate relevant parts of the codebase in parallel.`
          : `The user wants to clarify the following request: "${topic}"\n\nBegin the agentic-clarification process. Follow the agentic-clarification skill rules. Do not ask the user questions directly. If information is missing, state the missing information clearly in your output. Use the subagent tool with agent 'explorer' to investigate relevant parts of the codebase in parallel.`
        : isRootSession
          ? `The user wants to start an agentic-clarification session for their current task.\n\nBegin the agentic-clarification process. Follow the agentic-clarification skill rules. Ask ONE question using the ask_user_question tool to understand what the user wants to accomplish. Use the subagent tool with agent 'explorer' to investigate the codebase in parallel.`
          : `The user wants to start an agentic-clarification session for their current task.\n\nBegin the agentic-clarification process. Follow the agentic-clarification skill rules. Do not ask the user questions directly. If information is missing, state the missing information clearly in your output. Use the subagent tool with agent 'explorer' to investigate the codebase in parallel.`;

      pi.sendUserMessage(prompt);
    },
  });

  pi.registerCommand("plan", {
    description:
      "Generate an implementation plan — the agent follows agentic-plan-crafting skill rules",
    handler: async (args, ctx) => {
      const ok = await ctx.ui.confirm(
        "Start Agentic Plan Crafting",
        "The agent will create an executable implementation plan based on current context using the agentic-plan-crafting workflow.\n\nProceed?"
      );
      if (!ok) return;

      currentPhase = "planning";
      planProgress.clear();
      milestoneTracker.clear();
      ctx.ui.setStatus("harness", "Agentic planning workflow in progress...");

      const topic = args?.trim() || "";
      const prompt = topic
        ? isRootSession
          ? `Create an executable implementation plan for: "${topic}"\n\nFollow the agentic-plan-crafting skill rules. If a Context Brief exists from a previous agentic-clarification, use it as input. If not, use the ask_user_question tool to confirm goal, scope, and tech stack before writing the plan.`
          : `Create an executable implementation plan for: "${topic}"\n\nFollow the agentic-plan-crafting skill rules. If a Context Brief exists from a previous agentic-clarification, use it as input. If not, state any missing goal, scope, or tech-stack information explicitly in the plan assumptions before writing the plan.`
        : isRootSession
          ? `Create an executable implementation plan for the current task.\n\nFollow the agentic-plan-crafting skill rules. If a Context Brief exists from a previous agentic-clarification, use it as input. If not, use the ask_user_question tool to confirm goal, scope, and tech stack before writing the plan.`
          : `Create an executable implementation plan for the current task.\n\nFollow the agentic-plan-crafting skill rules. If a Context Brief exists from a previous agentic-clarification, use it as input. If not, state any missing goal, scope, or tech-stack information explicitly in the plan assumptions before writing the plan.`;

      pi.sendUserMessage(prompt);
    },
  });

  pi.registerCommand("ultraplan", {
    description:
      "Decompose a complex task into milestones — the agent dynamically selects reviewers",
    handler: async (args, ctx) => {
      const confirmed = await ctx.ui.confirm(
        "Start Agentic Milestone Planning (Ultraplan)",
        "The agent will:\n1. Compose a Problem Brief\n2. Decide which reviewer perspectives are needed\n3. Dispatch reviewers in parallel\n4. Synthesize a milestone DAG\n\nProceed?"
      );
      if (!confirmed) return;

      currentPhase = "ultraplanning";
      planProgress.clear();
      milestoneTracker.clear();
      ctx.ui.setStatus("harness", "Agentic milestone workflow in progress...");

      const topic = args?.trim() || "";
      const prompt = topic
        ? `Decompose the following complex task into milestones: "${topic}"\n\nFollow the agentic-milestone-planning skill rules. First compose a Problem Brief. Then dispatch all 3 reviewer agents in parallel using the subagent tool: reviewer-feasibility, reviewer-architecture, reviewer-risk. After all reviewers complete, synthesize their findings into a milestone DAG.`
        : `Decompose the current complex task into milestones.\n\nFollow the agentic-milestone-planning skill rules. First compose a Problem Brief from the current context. Then dispatch all 3 reviewer agents in parallel using the subagent tool: reviewer-feasibility, reviewer-architecture, reviewer-risk. After all reviewers complete, synthesize their findings into a milestone DAG.`;

      pi.sendUserMessage(prompt);
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
      activeGoalDocument = null;
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

  pi.registerCommand("ultrareview", {
    description:
      "Deep multi-agent code review — 10 parallel reviewers + verification + synthesis",
    handler: async (args, ctx) => {
      const topic = args?.trim() || "";
      if (topic && !REVIEW_TOPIC_RE.test(topic)) {
        ctx.ui.notify(
          `Invalid review target: "${topic}". Expected a PR number (e.g. 27), a branch name (e.g. feature/foo), or a PR URL (e.g. https://github.com/owner/repo/pull/27). Only alphanumerics, dot, dash, underscore, slash, and colon are allowed.`,
          "error"
        );
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Start Ultrareview",
        "The agent will:\n1. Auto-detect the review target (PR or local diff)\n2. Dispatch 10 subagents in parallel (5 reviewers × 2 seeds)\n3. Run a verification pass to dedupe and filter\n4. Synthesize the final report and save to docs/engineering-discipline/reviews/\n\nThis may take several minutes. Proceed?"
      );
      if (!confirmed) return;

      currentPhase = "ultrareviewing";
      activeGoalDocument = null;
      ctx.ui.setStatus("harness", "Ultrareview pipeline in progress...");

      const targetClause = topic
        ? `Review target: "${topic}" (may be a PR number, a PR URL, or a branch name). If it is a number or contains "://" (a URL), treat it as a PR reference and fetch the diff with \`gh pr diff ${topic}\` — \`gh\` accepts PR numbers and full PR URLs interchangeably. Otherwise treat it as a branch name and diff it against main with \`git diff main...${topic}\`.`
        : `Review target: auto-detect. First run \`git rev-parse --abbrev-ref HEAD\` to get the current branch. Then run \`gh pr list --head <branch> --json number --jq '.[0].number'\` to check for a matching PR. If a PR exists, use \`gh pr diff <number>\`. Otherwise, combine \`git diff main...HEAD\` with uncommitted changes from \`git diff\` and \`git diff --cached\`.`;

      const prompt = [
        "You are orchestrating a multi-stage code review pipeline. Execute all three stages in order.",
        "",
        targetClause,
        "",
        "If the diff is empty, report \"No changes to review\" and stop before dispatching any subagents.",
        "",
        "## Stage 1: Finding (parallel fleet)",
        "",
        "First, resolve the diff once and write it to a shared artifact such as `docs/engineering-discipline/reviews/.tmp/<date>-<topic>.diff` so all reviewers can read the same source without duplicating the full diff payload 10 times.",
        "",
        "Dispatch **10 subagents in parallel** using the subagent tool's parallel mode. This is 5 reviewer roles × 2 seeds each:",
        "- reviewer-bug (seed 1, seed 2)",
        "- reviewer-security (seed 1, seed 2)",
        "- reviewer-performance (seed 1, seed 2)",
        "- reviewer-test-coverage (seed 1, seed 2)",
        "- reviewer-consistency (seed 1, seed 2)",
        "",
        "For each task in the tasks array, the `task` field must include:",
        "1. The shared diff artifact path (or, only if absolutely necessary for a very small diff, a minimal relevant diff excerpt rather than the full inline diff)",
        "2. The list of affected file paths",
        "3. The seed number with this instruction: seed 1 = \"Perform a fresh independent pass\"; seed 2 = \"You are seed 2 — focus on findings seed 1 might miss by examining edge cases and alternative execution paths.\"",
        "4. An explicit instruction to read the shared diff artifact before opening touched files",
        "",
        "Invoke the subagent tool ONCE in parallel mode with a tasks array of 10 entries.",
        "",
        "## Stage 2: Verification",
        "",
        "After all 10 reviewers complete, aggregate their raw findings grouped by role (concatenate seed 1 and seed 2 outputs per role). Then dispatch `reviewer-verifier` in single mode with the aggregated findings as the task. The verifier will deduplicate, filter false positives, and assign final severity/confidence.",
        "",
        "## Stage 3: Synthesis",
        "",
        "Dispatch `review-synthesis` in single mode. The task must substitute these template slots:",
        "- `{VERIFIED_FINDINGS}` = verifier output from Stage 2",
        "- `{REVIEW_TARGET}` = the resolved target (e.g., 'PR #123' or 'branch feature/foo')",
        "- `{REVIEW_DATE}` = today's date as YYYY-MM-DD",
        "",
        "## Output",
        "",
        "1. Compute `<topic>`: if PR mode, use `pr-<number>`; if branch mode, use the sanitized branch name (replace `/` with `-`, lowercase).",
        "2. Compute `<date>`: today's date as YYYY-MM-DD.",
        "3. Write the full synthesis report to `docs/engineering-discipline/reviews/<date>-<topic>-review.md`. Create the directory if it does not exist.",
        "4. Stream a brief summary to chat: the 5 highest-priority findings (by severity then confidence), each with file:line and one-line description, plus the full saved path.",
        "",
        "NEVER dispatch any agent whose name contains \"worker\". Use only the reviewer-* and review-synthesis agents defined for this pipeline.",
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
    description: "Reset the workflow phase to idle (clears clarify/plan/ultraplan mode)",
    handler: async (_args, ctx) => {
      currentPhase = "idle";
      activeGoalDocument = null;
      planProgress.clear();
      milestoneTracker.clear();
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

    const rootDir = defaultHarnessStateRoot(ctx.cwd);
    const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
    let runId: string | undefined;
    for (const entry of branchEntries) {
      if (entry?.type === "custom" && entry?.customType === HARNESS_STATE_EVENT_CUSTOM_TYPE && entry?.data) {
        runId = (entry.data as any).runId;
        break;
      }
    }
    if (!runId) return;

    const snapshotPath = harnessStateSnapshotPath(rootDir, runId);
    const snapshot = await readHarnessStateSnapshot(snapshotPath);
    if (!snapshot) return;

    const activePlan = selectStructuredPlanForPaths(snapshot.state, extractPlanPathsFromArgs(args));
    if (!activePlan) return;

    const result = applyStructuredPlanTaskStatusUpdates(snapshot.state, {
      planId: activePlan.id,
      taskIds,
      status,
    });
    await writeHarnessStateSnapshot(snapshotPath, createHarnessStateSnapshot(result.state));
    for (const replayEvent of result.events) {
      (ctx.sessionManager as any)?.appendCustomEntry?.(HARNESS_STATE_EVENT_CUSTOM_TYPE, replayEvent);
    }
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
    }

    if (
      msg.role === "assistant" &&
      msg.stopReason !== "toolUse" &&
      !hasToolCallContent(msg)
    ) {
      const blockingAsyncRuns = getDefaultRegistry().listActive().filter(isAsyncRunBlockingFinal);
      if (blockingAsyncRuns.length > 0) {
        const guardText = buildAsyncFinalGuardText(blockingAsyncRuns);
        pi.sendUserMessage(
          `${guardText}\n\nContinue by explicitly choosing the next subagent action for each blocking run before finalizing.`,
          { deliverAs: "followUp" },
        );
        return { message: replaceAssistantMessageText(msg, guardText) };
      }
    }

    // LEGACY PATH — parser-derived plan/milestone loading from assistant prose.
    // Skip when structured state exists; harness tools handle updates directly.
    if (!harnessProgress?.hasState()) {
      await loadPlanFromAssistantMessageEnd(planProgress, event, ctx.cwd, sessionPlanPaths);
      loadMilestonesFromAssistantMessage(milestoneTracker, event);
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    activeTools.running.set(event.toolCallId, event.toolName);

    if (event.toolName === "subagent") {
      const args = getToolExecutionArgs(event, toolCallArgsById.get(event.toolCallId));
      if (args) {
        toolCallArgsById.set(event.toolCallId, args);
        await reloadPlanFromSubagentArgs(planProgress, args, ctx.cwd, sessionPlanPaths);
        const matchedTaskIds = startPlanSubagentTasks(planProgress, args);
        if (matchedTaskIds.length > 0) {
          planTaskIdsByToolCallId.set(event.toolCallId, matchedTaskIds);
          await persistStructuredSubagentTaskStatuses(ctx, args, matchedTaskIds, "running");
        }

        const startedMilestones = startMilestonesFromSubagentArgs(milestoneTracker, args);
        if (startedMilestones.length > 0) {
          persistProgressSnapshot(ctx);
        }
      }
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    activeTools.running.delete(event.toolCallId);

    if (event.toolName === "subagent") {
      const args = getToolExecutionArgs(event, toolCallArgsById.get(event.toolCallId));
      if (args) {
        const matchedTaskIds = planTaskIdsByToolCallId.get(event.toolCallId);
        const affectedTaskIds = completePlanSubagentTasks(planProgress, args, !(event.isError ?? false), matchedTaskIds);
        if (affectedTaskIds.length > 0) {
          persistProgressSnapshot(ctx);

          // Runtime enforcement: also persist to structured state.
          const taskStatus = !(event.isError ?? false) ? "completed" : "failed";
          await persistStructuredSubagentTaskStatuses(ctx, args, affectedTaskIds, taskStatus);
        }

        const success = !(event.isError ?? false);
        const hasValidator = subagentItemRecords(args).some((item) => item.agent === "plan-validator");
        if (hasValidator && planProgress.hasPlan()) {
          const progress = planProgress.getProgress();
          if (success && progress.completed === progress.total) {
            const milestonePaths = [...extractPlanPathsFromArgs(args), ...extractMilestonePathsFromArgs(args)];
            for (const planPath of milestonePaths) {
              const extracted = extractMilestoneId(planPath);
              if (extracted) {
                milestoneTracker.completeMilestone(extracted.id, true);
              }
            }
          } else if (!success) {
            const milestonePaths = [...extractPlanPathsFromArgs(args), ...extractMilestonePathsFromArgs(args)];
            for (const planPath of milestonePaths) {
              const extracted = extractMilestoneId(planPath);
              if (extracted) {
                milestoneTracker.completeMilestone(extracted.id, false);
              }
            }
          }
        }
      }
    }

    toolCallArgsById.delete(event.toolCallId);
    planTaskIdsByToolCallId.delete(event.toolCallId);
  });

  pi.on("session_start", async (_event, ctx) => {
    currentPhase = "idle";
    activeGoalDocument = null;
    clarificationDone = false;

    cacheStats.totalInput = 0;
    cacheStats.totalCacheRead = 0;
    activeTools.running.clear();
    toolCallArgsById.clear();
    planTaskIdsByToolCallId.clear();
    sessionPlanPaths.clear();
    planProgress.clear();
    milestoneTracker.clear();
    await getDefaultRegistry().restorePersisted(join(ctx.cwd, ".pi", "agent", "runs"));
    const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];

    // --- Structured-first session restore (M6) ---
    // Detect structured state via HARNESS_STATE_EVENT_CUSTOM_TYPE entries.
    // If structured state exists, use it as the primary restore path.
    // Otherwise, fall back to legacy parser-derived reconstruction.
    let structuredRunId: string | undefined;
    for (const entry of branchEntries) {
      if (entry?.type === "custom" && entry?.customType === HARNESS_STATE_EVENT_CUSTOM_TYPE && entry?.data) {
        const data = entry.data as { runId?: string };
        if (data.runId) {
          structuredRunId = data.runId;
          break;
        }
      }
    }

    if (structuredRunId) {
      // Primary path: load snapshot + replay structured events
      const rootDir = defaultHarnessStateRoot(ctx.cwd);
      const snapshot = await readHarnessStateSnapshot(harnessStateSnapshotPath(rootDir, structuredRunId));
      const events = branchEntries
        .filter((e: any) => e?.type === "custom" && e?.customType === HARNESS_STATE_EVENT_CUSTOM_TYPE)
        .map((e: any) => e.data)
        .filter((d: any) => d && typeof d === "object");
      const reconstructedState = replayHarnessEvents(
        snapshot?.state ?? createHarnessState({ runId: structuredRunId, title: structuredRunId }),
        events,
      );

      // Populate milestone tracker from structured state
      if (reconstructedState.milestones.length > 0) {
        milestoneTracker.loadMilestones(
          reconstructedState.milestones.map((m) => ({ id: m.id, name: m.name })),
        );
        milestoneTracker.restoreMilestoneStatuses(
          reconstructedState.milestones.map((m) => ({ id: m.id, status: m.status })),
        );
      }

      // Populate plan tracker from structured state if a plan exists
      const activePlan = reconstructedState.plans[0];
      if (activePlan && activePlan.tasks.length > 0) {
        // Load plan markdown if available for display
        if (activePlan.planFile) {
          sessionPlanPaths.add(activePlan.planFile);
          try {
            const planContent = await readFile(activePlan.planFile, "utf-8");
            planProgress.loadPlan(planContent);
          } catch { /* plan file not found, skip */ }
        }
        planProgress.restoreTaskStatuses(
          activePlan.tasks.map((t) => ({ id: t.id, status: t.status === "skipped" ? "failed" : t.status })),
        );
      }
    } else {
      // LEGACY PATH — parser-derived reconstruction for pre-structured sessions
      await reconstructPlanProgressFromSessionEntries(
        planProgress,
        branchEntries,
        ctx.cwd,
        sessionPlanPaths,
      );

      type MilestoneSnapshot = { milestoneStatuses?: Array<{ id: string; status: MilestoneStatus }>; activeTasks?: Array<{ name: string; done: boolean }> | null; activeMilestoneId?: string | null };

      let lastMilestoneSnapshot: MilestoneSnapshot | null = null;
      for (const entry of branchEntries) {
        if (entry?.type === "custom" && entry?.customType === MILESTONE_PROGRESS_CUSTOM_TYPE && entry?.data) {
          lastMilestoneSnapshot = entry.data as MilestoneSnapshot;
        }
      }

      if (lastMilestoneSnapshot?.milestoneStatuses) {
        for (const planPath of sessionPlanPaths) {
          milestoneTracker.mergeFromPaths([planPath]);
        }
        milestoneTracker.restoreMilestoneStatuses(lastMilestoneSnapshot.milestoneStatuses as Array<{ id: string; status: MilestoneStatus }>);

        if (lastMilestoneSnapshot.activeTasks && lastMilestoneSnapshot.activeMilestoneId) {
          const target = milestoneTracker.getMilestone(lastMilestoneSnapshot.activeMilestoneId);
          if (target) {
            target.tasks = lastMilestoneSnapshot.activeTasks;
          }
        }
      }

      if (!milestoneTracker.hasMilestones()) {
        for (const planPath of sessionPlanPaths) {
          milestoneTracker.mergeFromPaths([planPath]);
        }
      }

      const milestoneReplay = await reconstructMilestoneProgressFromSessionEntries(
        milestoneTracker,
        branchEntries,
        ctx.cwd,
      );
      if (milestoneReplay.sawCompletion) {
        planProgress.clear();
      }
    }

    workingVisibility?.restore();
    workingVisibility = new WorkingVisibilityController(
      planProgress,
      ctx.ui as { setWorkingVisible?: (visible: boolean) => void },
    );
    workingVisibility.start();

    showWelcomeHeader(ctx.ui);

    const uiSettings = resolveAgenticUiSettings({ cwd: ctx.cwd });

    harnessProgress = new HarnessProgressProvider();
    for (const entry of branchEntries) {
      if (entry?.type === "custom" && entry?.customType === HARNESS_STATE_EVENT_CUSTOM_TYPE && entry?.data) {
        const data = entry.data as { runId?: string };
        if (data.runId) {
          harnessProgress.setRunId(data.runId);
          break;
        }
      }
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
      }, cacheStats, activeTools, planProgress, tui, milestoneTracker, harnessProgress, {
        preset: uiSettings.footerPreset,
      });

      const originalDispose = footer.dispose.bind(footer);
      footer.dispose = () => {
        originalDispose();
        clearInterval(gitTimer);
        unsubBranch();
      };

      return footer;
    });

    installEditorComposition(ctx.ui as any);

    ctx.ui.notify(
      "Agentic Harness loaded: /clarify, /plan, /ultraplan, /reset-phase",
      "info"
    );
  });
}
