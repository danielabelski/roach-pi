import { readFile } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { parsePlan } from "./plan-parser.js";
import type { PlanProgressTracker, TaskStatus } from "./plan-progress.js";
import { parseStateMd, isMilestoneDirectoryPath, extractMilestoneId, isTodoFilePath, parseTodoMd, isCompletionFilePath, parseCompletionMd, type MilestoneStatus, type MilestoneTracker } from "./milestone-tracker.js";

const STATE_TABLE_IN_MESSAGE_RE = /[|│]\s*(M\d+)\s*[|│]/;

export function loadMilestonesFromAssistantMessage(
  milestoneTracker: MilestoneTracker,
  event: unknown,
): boolean {
  if (!event || typeof event !== "object") return false;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return false;
  if ((message as { role?: unknown }).role !== "assistant") return false;

  const text = extractMessageText(message);
  if (!text) return false;

  if (!STATE_TABLE_IN_MESSAGE_RE.test(text)) return false;

  const parsed = parseStateMd(text);
  if (parsed.length === 0) return false;

  milestoneTracker.loadMilestones(parsed.map((m) => ({ id: m.id, name: m.name })));
  for (const m of parsed) {
    milestoneTracker.setStatus(m.id, m.status);
  }
  return true;
}

export type PlanLoadOptions = {
  text?: string;
  path?: string;
  cwd?: string;
};

export type PlanToolResultEvent = {
  toolName: string;
  input?: Record<string, unknown>;
  content?: unknown;
};


const ENGINEERING_PLAN_PATH_RE = /(?:^|\/)docs\/engineering-discipline\/plans\/[^/\s"'`<>),]+\.md$/i;
const GENERIC_PLAN_PATH_RE = /(?:^|\/)(?:plans|plan)\/[^/\s"'`<>),]+\.md$/i;
const ENGINEERING_PLAN_PATH_IN_TEXT_RE = /(?:[^\s"'`<>),]*docs\/engineering-discipline\/plans\/[^\s"'`<>),]+\.md)/gi;

function normalizePathForMatch(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isPlanMarkdownPath(filePath: string): boolean {
  const normalized = normalizePathForMatch(filePath);
  return ENGINEERING_PLAN_PATH_RE.test(normalized) || GENERIC_PLAN_PATH_RE.test(normalized);
}

function hasPlanTasks(markdown: string): boolean {
  try {
    return parsePlan(markdown).tasks.length > 0;
  } catch {
    return false;
  }
}

function resolvePlanPath(filePath: string, cwd?: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd ?? process.cwd(), filePath);
}

function addPlanPath(paths: string[], candidate: unknown): void {
  if (typeof candidate !== "string") return;
  if (!isPlanMarkdownPath(candidate)) return;
  if (!paths.includes(candidate)) paths.push(candidate);
}

function addTaskTextPlanPaths(paths: string[], taskText: unknown): void {
  if (typeof taskText !== "string") return;
  for (const match of taskText.matchAll(ENGINEERING_PLAN_PATH_IN_TEXT_RE)) {
    addPlanPath(paths, match[0]);
  }
}

function addReads(paths: string[], reads: unknown): void {
  if (!Array.isArray(reads)) return;
  for (const readPath of reads) addPlanPath(paths, readPath);
}

const MILESTONE_PATH_IN_TEXT_RE = /[^\s"'`<>),]*milestones\/M\d+-[^\s"'`<>),]+\.md/gi;

function addMilestonePath(paths: string[], candidate: unknown): void {
  if (typeof candidate !== "string") return;
  if (extractMilestoneId(candidate) && !paths.includes(candidate)) {
    paths.push(candidate);
  }
}

function addMilestonePathsFromText(paths: string[], text: unknown): void {
  if (typeof text !== "string") return;
  for (const match of text.matchAll(MILESTONE_PATH_IN_TEXT_RE)) {
    addMilestonePath(paths, match[0]);
  }
}

function addMilestoneReads(paths: string[], reads: unknown): void {
  if (!Array.isArray(reads)) return;
  for (const readPath of reads) {
    addMilestonePath(paths, readPath);
    addMilestonePathsFromText(paths, readPath);
  }
}

function addSubagentItems(paths: string[], items: unknown): void {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    addPlanPath(paths, record.planFile);
    addReads(paths, record.reads);
    addTaskTextPlanPaths(paths, record.task);
  }
}

export function extractPlanPathsFromArgs(args: unknown): string[] {
  const paths: string[] = [];
  if (!args || typeof args !== "object") return paths;

  const record = args as Record<string, unknown>;
  addPlanPath(paths, record.planFile);
  addReads(paths, record.reads);
  addTaskTextPlanPaths(paths, record.task);
  addSubagentItems(paths, record.tasks);
  addSubagentItems(paths, record.chain);

  return paths;
}

export function extractMilestonePathsFromArgs(args: unknown): string[] {
  const paths: string[] = [];
  if (!args || typeof args !== "object") return paths;

  const record = args as Record<string, unknown>;
  addMilestonePath(paths, record.planFile);
  addMilestonePath(paths, record.output);
  addMilestonePath(paths, record.progress);
  addMilestoneReads(paths, record.reads);
  addMilestonePathsFromText(paths, record.task);

  for (const key of ["tasks", "chain"] as const) {
    const nested = record[key];
    if (!Array.isArray(nested)) continue;
    for (const item of nested) {
      if (!item || typeof item !== "object") continue;
      const nestedRecord = item as Record<string, unknown>;
      addMilestonePath(paths, nestedRecord.planFile);
      addMilestonePath(paths, nestedRecord.output);
      addMilestonePath(paths, nestedRecord.progress);
      addMilestoneReads(paths, nestedRecord.reads);
      addMilestonePathsFromText(paths, nestedRecord.task);
    }
  }

  return paths;
}

export function milestoneStatusForSubagentArgs(args: unknown): MilestoneStatus | null {
  const agents = subagentItemRecords(args)
    .map((item) => typeof item.agent === "string" ? item.agent : "")
    .filter(Boolean);

  if (agents.includes("plan-validator")) return "validating";
  if (agents.includes("plan-worker") || agents.includes("plan-compliance")) return "executing";
  if (extractMilestonePathsFromArgs(args).length > 0) return "planning";
  return null;
}

export function startMilestonesFromSubagentArgs(
  milestoneTracker: MilestoneTracker,
  args: unknown,
): string[] {
  const paths = extractMilestonePathsFromArgs(args);
  if (paths.length === 0) return [];

  milestoneTracker.mergeFromPaths(paths);

  const status = milestoneStatusForSubagentArgs(args);
  if (!status) return [];

  const started: string[] = [];
  for (const path of paths) {
    const extracted = extractMilestoneId(path);
    if (!extracted) continue;

    const milestone = milestoneTracker.getMilestone(extracted.id);
    if (!milestone) continue;
    if (milestone.status === "completed" || milestone.status === "failed" || milestone.status === "skipped") continue;

    milestoneTracker.setStatus(extracted.id, status);
    started.push(extracted.id);
    if (status === "planning") break;
  }

  return started;
}

export function extractToolResultText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const textContent = content.find((item) => {
    return !!item && typeof item === "object" && (item as { type?: unknown }).type === "text";
  }) as { text?: unknown } | undefined;
  return typeof textContent?.text === "string" ? textContent.text : undefined;
}

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

export function getToolExecutionArgs(
  event: unknown,
  storedArgs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (event && typeof event === "object" && "args" in event) {
    const args = (event as { args?: unknown }).args;
    if (args && typeof args === "object") {
      return args as Record<string, unknown>;
    }
  }
  return storedArgs;
}

export async function loadPlanFromTextOrFile(
  tracker: PlanProgressTracker,
  options: PlanLoadOptions,
): Promise<boolean> {
  if (options.text && hasPlanTasks(options.text)) {
    tracker.loadPlan(options.text);
    return true;
  }

  if (!options.path || !isPlanMarkdownPath(options.path)) return false;

  try {
    const fileText = await readFile(resolvePlanPath(options.path, options.cwd), "utf-8");
    if (!hasPlanTasks(fileText)) return false;
    tracker.loadPlan(fileText);
    return true;
  } catch {
    return false;
  }
}

export async function loadPlanFromToolResultEvent(
  tracker: PlanProgressTracker,
  event: PlanToolResultEvent,
  cwd?: string,
  sessionPlanPaths?: Set<string>,
): Promise<boolean> {
  if (event.toolName !== "read" && event.toolName !== "write") return false;

  const filePath = event.input?.path;
  if (typeof filePath !== "string") return false;

  const isKnownPath = isPlanMarkdownPath(filePath);

  if (isKnownPath) {
    const text = event.toolName === "write"
      ? (typeof event.input?.content === "string" ? event.input.content : undefined)
      : extractToolResultText(event.content);
    return loadPlanFromTextOrFile(tracker, { text, path: filePath, cwd });
  }

  if (event.toolName === "write") {
    const text = typeof event.input?.content === "string" ? event.input.content : undefined;
    if (text && hasPlanTasks(text)) {
      sessionPlanPaths?.add(filePath);
      tracker.loadPlan(text);
      return true;
    }
    return false;
  }

  if (sessionPlanPaths?.has(filePath)) {
    const text = extractToolResultText(event.content);
    return loadPlanFromTextOrFile(tracker, { text, path: filePath, cwd });
  }

  return false;
}

type SessionMessageEntryLike = {
  type?: unknown;
  message?: unknown;
};

type ToolCallRecord = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

function extractAssistantToolCalls(message: unknown): ToolCallRecord[] {
  if (!message || typeof message !== "object") return [];
  if ((message as { role?: unknown }).role !== "assistant") return [];

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  const calls: ToolCallRecord[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (record.type !== "toolCall") continue;
    if (typeof record.id !== "string" || typeof record.name !== "string") continue;
    if (!record.arguments || typeof record.arguments !== "object") continue;
    calls.push({
      id: record.id,
      name: record.name,
      args: record.arguments as Record<string, unknown>,
    });
  }
  return calls;
}

function getMessageFromEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as SessionMessageEntryLike;
  if (record.type !== "message") return undefined;
  return record.message;
}

const PLAN_PROGRESS_CUSTOM_TYPE = "plan-progress";

type TaskStatusSnapshot = { id: number; status: string };

function extractCustomEntrySnapshot(entry: unknown): TaskStatusSnapshot[] | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (record.type !== "custom" || record.customType !== PLAN_PROGRESS_CUSTOM_TYPE) return null;
  if (!record.data || typeof record.data !== "object") return null;
  const data = record.data as { taskStatuses?: unknown };
  if (!Array.isArray(data.taskStatuses)) return null;
  return data.taskStatuses as TaskStatusSnapshot[];
}

export async function reconstructMilestoneProgressFromSessionEntries(
  milestoneTracker: MilestoneTracker,
  entries: unknown[],
  cwd?: string,
): Promise<{ changed: boolean; sawCompletion: boolean }> {
  const toolCallArgsById = new Map<string, Record<string, unknown>>();
  let changed = false;
  let sawCompletion = false;

  for (const entry of entries) {
    const message = getMessageFromEntry(entry);
    if (!message || typeof message !== "object") continue;

    const role = (message as { role?: unknown }).role;

    if (role === "assistant") {
      if (loadMilestonesFromAssistantMessage(milestoneTracker, { message })) {
        changed = true;
      }
      for (const call of extractAssistantToolCalls(message)) {
        toolCallArgsById.set(call.id, call.args);
      }
      continue;
    }

    if (role !== "toolResult") continue;

    const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
    const toolName = (message as { toolName?: unknown }).toolName;
    if (typeof toolCallId !== "string" || typeof toolName !== "string") continue;

    const args = toolCallArgsById.get(toolCallId);
    if (args && (toolName === "read" || toolName === "write" || toolName === "edit")) {
      const detected = await detectMilestonesFromToolResult(milestoneTracker, {
        toolName,
        input: args,
        content: (message as { content?: unknown }).content,
      }, cwd);
      if (detected) changed = true;

      const filePath = typeof args.path === "string"
        ? args.path
        : typeof args.file_path === "string"
          ? args.file_path
          : "";
      if (detected && isCompletionFilePath(filePath)) {
        sawCompletion = true;
      }
    }

    toolCallArgsById.delete(toolCallId);
  }

  return { changed, sawCompletion };
}

export async function reconstructPlanProgressFromSessionEntries(
  tracker: PlanProgressTracker,
  entries: unknown[],
  cwd?: string,
  sessionPlanPaths: Set<string> = new Set<string>(),
): Promise<void> {
  let lastSnapshot: TaskStatusSnapshot[] | null = null;
  let lastSnapshotIndex = -1;

  for (let i = 0; i < entries.length; i++) {
    const snapshot = extractCustomEntrySnapshot(entries[i]);
    if (snapshot) {
      lastSnapshot = snapshot;
      lastSnapshotIndex = i;
    }
  }

  const toolCallArgsById = new Map<string, Record<string, unknown>>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (i === lastSnapshotIndex && lastSnapshot) {
      continue;
    }

    const message = getMessageFromEntry(entry);
    if (!message || typeof message !== "object") continue;

    const role = (message as { role?: unknown }).role;

    if (role === "assistant") {
      await loadPlanFromAssistantMessageEnd(tracker, { message }, cwd, sessionPlanPaths);
      if (i > lastSnapshotIndex && lastSnapshot) {
        tracker.restoreTaskStatuses(lastSnapshot as Array<{ id: number; status: TaskStatus }>);
        lastSnapshot = null;
      }
      for (const call of extractAssistantToolCalls(message)) {
        toolCallArgsById.set(call.id, call.args);
      }
      continue;
    }

    if (role !== "toolResult") continue;

    const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
    const toolName = (message as { toolName?: unknown }).toolName;
    if (typeof toolCallId !== "string" || typeof toolName !== "string") continue;

    const args = toolCallArgsById.get(toolCallId);
    if (toolName === "read" || toolName === "write") {
      await loadPlanFromToolResultEvent(tracker, {
        toolName,
        input: args,
        content: (message as { content?: unknown }).content,
      }, cwd, sessionPlanPaths);
    }

    if (toolName === "subagent" && args) {
      await reloadPlanFromSubagentArgs(tracker, args, cwd);
      const matchedTaskIds = startPlanSubagentTasks(tracker, args);
      completePlanSubagentTasks(
        tracker,
        args,
        !((message as { isError?: unknown }).isError ?? false),
        matchedTaskIds,
      );
    }

    toolCallArgsById.delete(toolCallId);
  }

  tracker.demoteRunningToPending();
}

export async function reloadPlanFromSubagentArgs(
  tracker: PlanProgressTracker,
  args: unknown,
  cwd?: string,
): Promise<boolean> {
  for (const planPath of extractPlanPathsFromArgs(args)) {
    if (await loadPlanFromTextOrFile(tracker, { path: planPath, cwd })) {
      return true;
    }
  }
  return false;
}

export function subagentItemRecords(args: unknown): Record<string, unknown>[] {
  if (!args || typeof args !== "object") return [];

  const record = args as Record<string, unknown>;
  const items: Record<string, unknown>[] = [];

  if (typeof record.agent === "string" || typeof record.task === "string") {
    items.push(record);
  }

  for (const key of ["tasks", "chain"] as const) {
    const nested = record[key];
    if (!Array.isArray(nested)) continue;
    for (const item of nested) {
      if (item && typeof item === "object") {
        items.push(item as Record<string, unknown>);
      }
    }
  }

  return items;
}

function taskText(item: Record<string, unknown>): string {
  return typeof item.task === "string" ? item.task : "";
}

function planTaskId(item: Record<string, unknown>): number | null {
  return typeof item.planTaskId === "number" && Number.isInteger(item.planTaskId)
    ? item.planTaskId
    : null;
}

export function startPlanSubagentTasks(
  tracker: PlanProgressTracker,
  args: unknown,
): number[] {
  if (!tracker.hasPlan()) return [];

  const matchedIds: number[] = [];
  for (const item of subagentItemRecords(args)) {
    const taskId = planTaskId(item);
    const matchedId = taskId !== null
      ? tracker.startTaskById(taskId)
      : tracker.startTaskByMatch(taskText(item));
    if (matchedId !== null) matchedIds.push(matchedId);
  }
  return matchedIds;
}

export function completePlanSubagentTasks(
  tracker: PlanProgressTracker,
  args: unknown,
  success: boolean,
  matchedTaskIds?: number[],
): number[] {
  if (!tracker.hasPlan()) return [];

  const items = subagentItemRecords(args);
  const shouldComplete = !success || items.some((item) => item.agent === "plan-validator");

  if (matchedTaskIds && matchedTaskIds.length > 0) {
    if (shouldComplete) {
      for (const taskId of matchedTaskIds) {
        tracker.completeTask(taskId, success);
      }
    }
    return matchedTaskIds;
  }

  const completedIds: number[] = [];
  const matchedSet = new Set(matchedTaskIds ?? []);
  for (const item of items) {
    const taskId = planTaskId(item);
    if (taskId !== null && !matchedSet.has(taskId)) continue;
    if (taskId !== null) {
      if (shouldComplete) tracker.completeTask(taskId, success);
      completedIds.push(taskId);
      continue;
    }

    if (!shouldComplete) continue;
    const matchedId = tracker.completeTaskByMatch(taskText(item), success);
    if (matchedId !== null) completedIds.push(matchedId);
  }
  return completedIds;
}

const STATE_MD_RE = /(?:^|\/)state\.md$/i;

export async function detectMilestonesFromToolResult(
  milestoneTracker: MilestoneTracker,
  event: { toolName: string; input?: Record<string, unknown>; content?: unknown },
  cwd?: string,
): Promise<boolean> {
  if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return false;

  const filePath = typeof event.input?.path === "string"
    ? event.input.path
    : typeof event.input?.file_path === "string"
      ? event.input.file_path
      : "";
  if (!filePath) return false;

  let changed = false;

  if (isMilestoneDirectoryPath(filePath)) {
    const extracted = extractMilestoneId(filePath);
    if (extracted) {
      milestoneTracker.mergeFromPaths([filePath]);
      changed = true;
    }
  }

  if (STATE_MD_RE.test(filePath)) {
    let text: string | undefined;
    if (event.toolName === "write") {
      text = typeof event.input?.content === "string" ? event.input.content : undefined;
    } else if (event.toolName === "read") {
      text = extractToolResultText(event.content);
    }

    if (text) {
      const parsed = parseStateMd(text);
      if (parsed.length > 0) {
        // state.md is the source of truth for the active harness; replace stale milestones.
        milestoneTracker.loadMilestones(parsed.map((m) => ({ id: m.id, name: m.name })));
        for (const m of parsed) {
          milestoneTracker.setStatus(m.id, m.status);
        }
        changed = true;
      }
    }

    if (!changed) {
      try {
        const resolved = isAbsolute(filePath) ? filePath : resolve(cwd ?? process.cwd(), filePath);
        const diskText = await readFile(resolved, "utf-8");
        const parsed = parseStateMd(diskText);
        if (parsed.length > 0) {
          milestoneTracker.loadMilestones(parsed.map((m) => ({ id: m.id, name: m.name })));
          for (const m of parsed) {
            milestoneTracker.setStatus(m.id, m.status);
          }
          changed = true;
        }
      } catch {
        // Ignore missing or unreadable session files.
      }
    }
  }

  if (isCompletionFilePath(filePath)) {
    let text: string | undefined;
    if (event.toolName === "write") {
      text = typeof event.input?.content === "string" ? event.input.content : undefined;
    } else if (event.toolName === "read") {
      text = extractToolResultText(event.content);
    }

    if (!text) {
      try {
        const resolved = isAbsolute(filePath) ? filePath : resolve(cwd ?? process.cwd(), filePath);
        text = await readFile(resolved, "utf-8");
      } catch {
        // Ignore missing or unreadable session files.
      }
    }

    if (text) {
      const parsed = parseCompletionMd(text);
      if (parsed.length > 0) {
        milestoneTracker.loadMilestones(parsed.map((m) => ({ id: m.id, name: m.name })));
        for (const m of parsed) {
          milestoneTracker.setStatus(m.id, m.status);
        }
        changed = true;
      }
    }
  }

  if (isTodoFilePath(filePath)) {
    let text: string | undefined;
    if (event.toolName === "write") {
      text = typeof event.input?.content === "string" ? event.input.content : undefined;
    } else if (event.toolName === "read") {
      text = extractToolResultText(event.content);
    }

    if (!text) {
      try {
        const resolved = isAbsolute(filePath) ? filePath : resolve(cwd ?? process.cwd(), filePath);
        text = await readFile(resolved, "utf-8");
      } catch {
        // Ignore missing or unreadable session files.
      }
    }

    if (text) {
      const tasks = parseTodoMd(text);
      if (tasks.length > 0) {
        milestoneTracker.updateActiveTasks(tasks);
        changed = true;
      }
    }
  }

  return changed;
}
