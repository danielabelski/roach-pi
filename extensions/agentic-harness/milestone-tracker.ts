import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

export type MilestoneStatus = "pending" | "planning" | "executing" | "validating" | "completed" | "failed" | "skipped";

export interface TrackedMilestone {
  id: string;
  name: string;
  status: MilestoneStatus;
  tasks?: TrackedTodoTask[];
}

export interface TrackedTodoTask {
  name: string;
  done: boolean;
}

type MilestoneChangeListener = () => void;

const MILESTONE_FILE_RE = /(?:^|\/)(M\d+)-([^/\s]+)\.md$/i;
const MILESTONE_DIR_RE = /(?:^|\/)milestones\//i;
const STATE_TABLE_ROW_RE = /[|│]\s*(M\d+)\s*[|│]\s*([^|│]+?)\s*[|│]\s*(?:[^a-zA-Z]*?)(\w+)\s*[|│]/;
const TODO_CHECKBOX_RE = /^\s*-\s*\[([ xX])\]\s+(.+)$/;
const TODO_FILE_RE = /(?:^|\/)todo\.md$/i;
const COMPLETION_FILE_RE = /(?:^|\/)completion\.md$/i;
const COMPLETION_TABLE_ROW_RE = /[|│]\s*(M\d+)(?::|\s+[-—])?\s*([^|│]*?)\s*[|│]\s*(?:[^a-zA-Z]*?)(\w+)\s*[|│]/;

const STATUS_KEYWORDS: Record<string, MilestoneStatus> = {
  completed: "completed",
  done: "completed",
  executing: "executing",
  running: "executing",
  validating: "validating",
  reviewing: "validating",
  planning: "planning",
  pending: "pending",
  ready: "pending",
  failed: "failed",
  skipped: "skipped",
};

function normalizeStatus(raw: string): MilestoneStatus | null {
  return STATUS_KEYWORDS[raw.trim().toLowerCase()] ?? null;
}

export function isMilestoneDirectoryPath(filePath: string): boolean {
  return MILESTONE_DIR_RE.test(filePath);
}

export function extractMilestoneId(filePath: string): { id: string; name: string } | null {
  const match = filePath.match(MILESTONE_FILE_RE);
  if (!match) return null;
  const id = match[1].toUpperCase();
  const name = match[2].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { id, name };
}

export function isTodoFilePath(filePath: string): boolean {
  return TODO_FILE_RE.test(filePath);
}

export function isCompletionFilePath(filePath: string): boolean {
  return COMPLETION_FILE_RE.test(filePath);
}

export function parseCompletionMd(markdown: string): Array<{ id: string; name: string; status: MilestoneStatus }> {
  const results: Array<{ id: string; name: string; status: MilestoneStatus }> = [];
  const seen = new Set<string>();

  for (const line of markdown.split("\n")) {
    const match = line.match(COMPLETION_TABLE_ROW_RE);
    if (match) {
      const id = match[1].toUpperCase();
      const name = match[2].trim();
      const status = normalizeStatus(match[3]);
      if (status && !seen.has(id)) {
        seen.add(id);
        results.push({ id, name, status });
      }
    }
  }

  results.sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10));
  return results;
}

export function parseStateMd(markdown: string): Array<{ id: string; name: string; status: MilestoneStatus }> {
  const results: Array<{ id: string; name: string; status: MilestoneStatus }> = [];
  const seen = new Set<string>();

  for (const line of markdown.split("\n")) {
    const match = line.match(STATE_TABLE_ROW_RE);
    if (match) {
      const id = match[1].toUpperCase();
      const name = match[2].trim();
      const status = normalizeStatus(match[3]);
      if (status && !seen.has(id)) {
        seen.add(id);
        results.push({ id, name, status });
      }
    }
  }

  results.sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10));
  return results;
}

export function parseTodoMd(markdown: string): Array<{ name: string; done: boolean }> {
  const tasks: Array<{ name: string; done: boolean }> = [];
  for (const line of markdown.split("\n")) {
    const match = line.match(TODO_CHECKBOX_RE);
    if (match) {
      tasks.push({ name: match[2].replace(/\*\*/g, "").trim(), done: match[1] !== " " });
    }
  }
  return tasks;
}

export class MilestoneTracker {
  private milestones: TrackedMilestone[] = [];
  private changeListeners = new Set<MilestoneChangeListener>();

  loadMilestones(milestones: Array<{ id: string; name: string }>): void {
    this.milestones = milestones.map((m) => ({
      id: m.id,
      name: m.name,
      status: "pending",
    }));
    this.sortMilestones();
    this.notifyChanged();
  }

  private sortMilestones(): void {
    this.milestones.sort((a, b) => {
      const numA = parseInt(a.id.slice(1), 10);
      const numB = parseInt(b.id.slice(1), 10);
      return numA - numB;
    });
  }

  loadFromPaths(paths: string[]): void {
    const seen = new Set<string>();
    const milestones: Array<{ id: string; name: string }> = [];
    for (const path of paths) {
      const extracted = extractMilestoneId(path);
      if (extracted && !seen.has(extracted.id)) {
        seen.add(extracted.id);
        milestones.push(extracted);
      }
    }
    if (milestones.length > 0) {
      this.loadMilestones(milestones);
    }
  }

  mergeFromPaths(paths: string[]): void {
    const existing = new Map(this.milestones.map((m) => [m.id, m]));
    let changed = false;

    for (const path of paths) {
      const extracted = extractMilestoneId(path);
      if (extracted && !existing.has(extracted.id)) {
        existing.set(extracted.id, { ...extracted, status: "pending" });
        changed = true;
      }
    }

    if (changed) {
      this.milestones = [...existing.values()];
      this.sortMilestones();
      this.notifyChanged();
    }
  }

  clear(): void {
    const had = this.milestones.length > 0;
    this.milestones = [];
    if (had) this.notifyChanged();
  }

  hasMilestones(): boolean {
    return this.milestones.length > 0;
  }

  getMilestone(id: string): TrackedMilestone | undefined {
    return this.milestones.find((m) => m.id === id);
  }

  updateActiveTasks(tasks: Array<{ name: string; done: boolean }>): void {
    const active = this.milestones.find((m) =>
      m.status === "executing" || m.status === "planning" || m.status === "validating"
    );

    if (!active) return;
    active.tasks = tasks;
    this.notifyChanged();
  }

  getActiveMilestone(): TrackedMilestone | undefined {
    return this.milestones.find((m) =>
      m.status === "executing" || m.status === "planning" || m.status === "validating"
    );
  }

  setStatus(id: string, status: MilestoneStatus): void {
    const milestone = this.milestones.find((m) => m.id === id);
    if (!milestone || milestone.status === status) return;
    milestone.status = status;
    this.notifyChanged();
  }

  startMilestone(id: string): void {
    const milestone = this.milestones.find((m) => m.id === id);
    if (!milestone) return;
    if (milestone.status === "pending" || milestone.status === "planning") {
      milestone.status = "executing";
      this.notifyChanged();
    }
  }

  completeMilestone(id: string, success: boolean): void {
    const milestone = this.milestones.find((m) => m.id === id);
    if (!milestone) return;
    if (milestone.status === "executing" || milestone.status === "validating") {
      milestone.status = success ? "completed" : "failed";
      this.notifyChanged();
    }
  }

  setOnChange(listener: MilestoneChangeListener | null): void {
    this.changeListeners.clear();
    if (listener) this.changeListeners.add(listener);
  }

  subscribeOnChange(listener: MilestoneChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChanged(): void {
    for (const listener of [...this.changeListeners]) listener();
  }

  getMilestoneStatuses(): Array<{ id: string; status: MilestoneStatus }> {
    return this.milestones.map((m) => ({ id: m.id, status: m.status }));
  }

  restoreMilestoneStatuses(statuses: Array<{ id: string; status: MilestoneStatus }>): void {
    const byId = new Map(statuses.map((s) => [s.id, s.status]));
    let changed = false;
    for (const milestone of this.milestones) {
      const restored = byId.get(milestone.id);
      if (restored && milestone.status !== restored) {
        milestone.status = restored;
        changed = true;
      }
    }
    if (changed) this.notifyChanged();
  }

  getSummary(): { completed: number; total: number; failed: number; running: number; pending: number; skipped: number } {
    const completed = this.milestones.filter((m) => m.status === "completed").length;
    const failed = this.milestones.filter((m) => m.status === "failed").length;
    const running = this.milestones.filter((m) => m.status === "executing" || m.status === "planning" || m.status === "validating").length;
    const pending = this.milestones.filter((m) => m.status === "pending").length;
    const skipped = this.milestones.filter((m) => m.status === "skipped").length;
    return { completed, total: this.milestones.length, failed, running, pending, skipped };
  }

  render(theme: Theme, maxWidth: number): string[] {
    if (!this.hasMilestones()) return [];

    const width = Math.max(0, maxWidth);
    if (width === 0) return [];

    const lines: string[] = [];
    const clampLine = (line: string) => truncateToWidth(line, width);

    const t = theme;
    const summary = this.getSummary();
    const pct = Math.round((summary.completed / summary.total) * 100);
    const barWidth = Math.min(8, Math.max(1, Math.floor(width / 12)));
    const filled = Math.round((pct / 100) * barWidth);
    const bar =
      t.fg("success", "█".repeat(filled)) +
      t.fg("dim", "░".repeat(barWidth - filled));

    const parts: string[] = [`${bar} ${summary.completed}/${summary.total}`];
    if (summary.failed > 0) parts.push(t.fg("error", `${summary.failed}✗`));
    if (summary.running > 0) parts.push(t.fg("warning", `${summary.running}▶`));
    if (summary.skipped > 0) parts.push(t.fg("dim", `${summary.skipped}⏭`));
    lines.push(clampLine(`  ${parts.join(t.fg("dim", " "))}`));

    const milestoneParts: string[] = [];
    for (const m of this.milestones) {
      let icon: string;
      let color: Parameters<Theme["fg"]>[0];

      switch (m.status) {
        case "completed":
          icon = "✓";
          color = "success";
          break;
        case "failed":
          icon = "✗";
          color = "error";
          break;
        case "skipped":
          icon = "⏭";
          color = "dim";
          break;
        case "executing":
          icon = "▶";
          color = "warning";
          break;
        case "planning":
          icon = "◆";
          color = "accent";
          break;
        case "validating":
          icon = "◎";
          color = "accent";
          break;
        default:
          icon = "○";
          color = "dim";
      }

      milestoneParts.push(`${t.fg(color, icon)}${t.fg(color, m.id)}`);
    }

    lines.push(clampLine(`  ${milestoneParts.join("  ")}`));

    const active = this.getActiveMilestone();
    if (active?.tasks && active.tasks.length > 0) {
      const tasks = active.tasks;
      const done = tasks.filter((t) => t.done).length;
      const total = tasks.length;
      const taskBarWidth = Math.min(8, Math.max(1, Math.floor(width / 12)));
      const taskFilled = Math.round((done / total) * taskBarWidth);
      const taskBar =
        t.fg("success", "\u2588".repeat(taskFilled)) +
        t.fg("dim", "\u2591".repeat(taskBarWidth - taskFilled));
      lines.push(clampLine(`  ${t.fg("dim", "\u2514\u2500")} ${taskBar} ${t.fg("dim", `${done}/${total}`)} ${t.fg("accent", active.id)}`));

      const maxTasks = Math.min(5, tasks.length);
      for (let i = 0; i < maxTasks; i++) {
        const task = tasks[i];
        const icon = task.done ? t.fg("success", "\u2713") : t.fg("dim", "\u25CB");
        const taskName = truncateToWidth(task.name, Math.max(0, width - 6));
        lines.push(clampLine(`    ${icon} ${t.fg("toolOutput", taskName)}`));
      }
      if (tasks.length > maxTasks) {
        lines.push(clampLine(`    ${t.fg("dim", `... +${tasks.length - maxTasks} more`)}`));
      }
    }

    return lines;
  }
}
