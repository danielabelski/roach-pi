import { randomBytes } from "crypto";
import { readFile, writeFile, mkdir, readdir, rename } from "fs/promises";
import { join, dirname } from "path";
import { execFile } from "child_process";
import { killTmuxPane } from "./tmux.js";
import { emptyUsage, type AsyncDependency, type AsyncRunRecord, type AsyncRunStatus, type RunProgress, type SingleResult } from "./types.js";

export type RunRegistryListener = (runId: string, record: AsyncRunRecord) => void;
export type CompletionNotifier = (record: AsyncRunRecord) => void;

interface RunEntry {
  record: AsyncRunRecord;
  abortController?: AbortController;
}

const ASYNC_RUN_FILE = "async-run.json";
const KILL_TIMEOUT_MS = 5000;

function defaultRunStateRoot(cwd = process.cwd()): string {
  return join(cwd, ".pi", "agent", "runs");
}

function asyncRunRecordPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, ASYNC_RUN_FILE);
}

export class RunRegistry {
  private runs = new Map<string, RunEntry>();
  private globalListeners = new Set<RunRegistryListener>();
  private killTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private completionNotifier?: CompletionNotifier;

  register(agent: string, task: string, backend: "native" | "tmux", abortController?: AbortController, dependency?: AsyncDependency): string {
    const runId = randomBytes(8).toString("hex");
    const now = new Date().toISOString();
    const record: AsyncRunRecord = {
      schemaVersion: 1,
      runId,
      agent,
      task,
      dependency,
      status: "spawning",
      progress: { usage: emptyUsage(), elapsedMs: 0, startedAt: Date.now() },
      createdAt: now,
      updatedAt: now,
      backend,
    };
    this.runs.set(runId, { record, abortController });
    this.notify(runId, record);
    return runId;
  }

  update(runId: string, patch: {
    status?: AsyncRunStatus;
    pid?: number;
    pgid?: number;
    paneId?: string;
    sessionName?: string;
    tmuxBinary?: string;
    progress?: Partial<RunProgress>;
    result?: SingleResult;
  }): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    const now = new Date().toISOString();
    if (patch.status) entry.record.status = patch.status;
    if (patch.pid !== undefined) entry.record.pid = patch.pid;
    if (patch.pgid !== undefined) entry.record.pgid = patch.pgid;
    if (patch.paneId !== undefined) entry.record.paneId = patch.paneId;
    if (patch.sessionName !== undefined) entry.record.sessionName = patch.sessionName;
    if (patch.tmuxBinary !== undefined) entry.record.tmuxBinary = patch.tmuxBinary;
    if (patch.progress) {
      entry.record.progress = { ...entry.record.progress, ...patch.progress };
    }
    if (patch.result) entry.record.result = patch.result;
    entry.record.updatedAt = now;
    entry.record.progress.elapsedMs = Date.now() - entry.record.progress.startedAt;
    this.notify(runId, entry.record);
  }

  complete(runId: string, status: "completed" | "failed" | "interrupted", result?: SingleResult): void {
    this.update(runId, { status, result });
    this.clearKillTimer(runId);
    const entry = this.runs.get(runId);
    if (entry && this.completionNotifier) {
      try { this.completionNotifier(entry.record); } catch { /* ignore */ }
    }
    setTimeout(() => this.runs.delete(runId), 60_000).unref?.();
  }

  getStatus(runId: string): AsyncRunRecord | undefined {
    return this.runs.get(runId)?.record;
  }

  waitForCompletion(runId: string, timeoutMs = 600_000): Promise<{ record?: AsyncRunRecord; timedOut: boolean }> {
    const record = this.getStatus(runId);
    if (!record) return Promise.resolve({ record: undefined, timedOut: false });
    if (isTerminalStatus(record.status)) return Promise.resolve({ record, timedOut: false });

    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: { record?: AsyncRunRecord; timedOut: boolean }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        resolve(result);
      };

      unsubscribe = this.subscribe((updatedRunId, updatedRecord) => {
        if (updatedRunId !== runId) return;
        if (isTerminalStatus(updatedRecord.status)) {
          finish({ record: updatedRecord, timedOut: false });
        }
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          finish({ record: this.getStatus(runId), timedOut: true });
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  listActive(): AsyncRunRecord[] {
    return Array.from(this.runs.values()).map(e => e.record);
  }

  abort(runId: string): boolean {
    const entry = this.runs.get(runId);
    if (!entry?.abortController) return false;
    entry.abortController.abort();
    return true;
  }

  interrupt(runId: string): boolean {
    const entry = this.runs.get(runId);
    if (!entry) return false;
    const { record } = entry;
    if (record.status !== "running" && record.status !== "spawning") return false;

    if (record.backend === "tmux") {
      return this.interruptTmux(record);
    }
    return this.interruptNative(runId, record);
  }

  private interruptNative(runId: string, record: AsyncRunRecord): boolean {
    const pid = record.pid;
    if (!pid) return false;

    this.clearKillTimer(runId);

    try {
      if (process.platform !== "win32") {
        process.kill(-pid, "SIGTERM");
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch (err: any) {
      if (err?.code === "ESRCH") {
        this.complete(runId, "interrupted");
        return true;
      }
      return false;
    }

    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32") {
          process.kill(-pid, "SIGKILL");
        } else {
          process.kill(pid, "SIGKILL");
        }
      } catch { /* already dead */ }
    }, KILL_TIMEOUT_MS);
    timer.unref?.();
    this.killTimers.set(runId, timer);

    return true;
  }

  private interruptTmux(record: AsyncRunRecord): boolean {
    const paneId = record.paneId;
    if (!paneId) return false;
    const binary = record.tmuxBinary || "tmux";

    this.clearKillTimer(record.runId);

    execFile(binary, ["send-keys", "-t", paneId, "C-c"], () => undefined);

    const timer = setTimeout(() => {
      killTmuxPane(paneId, undefined, binary);
    }, KILL_TIMEOUT_MS);
    timer.unref?.();
    this.killTimers.set(record.runId, timer);

    return true;
  }

  private clearKillTimer(runId: string): void {
    const timer = this.killTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.killTimers.delete(runId);
    }
  }

  async persist(runId: string, rootDir = defaultRunStateRoot()): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) return;
    const file = asyncRunRecordPath(rootDir, runId);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(entry.record, null, 2)}\n`, "utf-8");
    await rename(tmp, file);
  }

  async load(runId: string, rootDir = defaultRunStateRoot()): Promise<AsyncRunRecord | undefined> {
    try {
      const raw = await readFile(asyncRunRecordPath(rootDir, runId), "utf-8");
      return JSON.parse(raw) as AsyncRunRecord;
    } catch {
      return undefined;
    }
  }

  async listPersisted(rootDir = defaultRunStateRoot()): Promise<AsyncRunRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(rootDir);
    } catch {
      return [];
    }
    const records: AsyncRunRecord[] = [];
    for (const entry of entries) {
      const record = await this.load(entry, rootDir);
      if (record) records.push(record);
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return records;
  }

  abortAll(): void {
    for (const [runId, entry] of this.runs) {
      if (entry.record.status === "running" || entry.record.status === "spawning") {
        this.interrupt(runId);
      }
    }
  }

  setCompletionNotifier(notifier: CompletionNotifier): void {
    this.completionNotifier = notifier;
  }

  subscribe(listener: RunRegistryListener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  private notify(runId: string, record: AsyncRunRecord): void {
    for (const listener of this.globalListeners) {
      try { listener(runId, record); } catch { /* ignore listener errors */ }
    }
  }
}

function isTerminalStatus(status: AsyncRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

let defaultRegistry: RunRegistry | undefined;
export function getDefaultRegistry(): RunRegistry {
  if (!defaultRegistry) defaultRegistry = new RunRegistry();
  return defaultRegistry;
}
