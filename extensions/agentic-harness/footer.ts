import { truncateToWidth, visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { ReadonlyFooterDataProvider } from "@mariozechner/pi-coding-agent";
import { basename } from "path";
import { PLAN_PROGRESS_SPINNER_MS, type PlanProgressTracker } from "./plan-progress.js";
import type { MilestoneTracker } from "./milestone-tracker.js";
import type { FooterGlyphMode, FooterPresetName } from "./ui-settings.js";
import type { HarnessProgressProvider } from "./harness-progress.js";

// Types

export interface GitStats {
  ahead: number;
  behind: number;
  dirty: number;
  untracked: number;
}

export interface ModelInfo {
  name: string;
  isLatest: boolean;
}

export interface FooterContext {
  cwd: string;
  getModelName: () => string | undefined;
  getContextUsage: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  getGitStats: () => GitStats | undefined;
  getThinkingLevel: () => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  getModelInfo: () => ModelInfo | undefined;
}

export interface CacheStats {
  totalInput: number;
  totalCacheRead: number;
}

export interface ActiveTools {
  running: Map<string, string>;
}

type FooterSegmentId = "logo" | "path" | "git" | "model" | "thinking" | "context" | "statuses" | "tools" | "cache";

type FooterSegmentColor = ThemeColor | "logo" | "path" | "git" | "model" | "thinking" | "context" | "default";

type FooterSegment = {
  id: FooterSegmentId;
  text: string;
  icon: string;
  color: FooterSegmentColor;
  priority: number;
};

type FooterPresetDefinition = {
  lines: FooterSegmentId[][];
};

export interface FooterOptions {
  preset?: FooterPresetName;
  glyphs?: FooterGlyphMode;
}

// Nerd Font Icons

const ICONS = {
  logo: "π",
  folder: "",
  branch: "󰘬",
  model: "",
  thinking: "󰌵",
  context: "󰍛",
  cache: "󰆼",
  tool: "󰒓",
  status: "󰄬",
} as const;

const ICONS_PLAIN = {
  logo: "π",
  folder: "📁",
  branch: "⎇",
  model: "◆",
  thinking: "◇",
  context: "◈",
  cache: "⊡",
  tool: "▶",
  status: "●",
} as const;

let useNerdIcons = false;
function getIcons(glyphs?: FooterGlyphMode) {
  const mode = glyphs ?? (useNerdIcons ? "nerd" : "plain");
  return mode === "nerd" ? ICONS : ICONS_PLAIN;
}

// Presets

const FOOTER_PRESET_DEFINITIONS: Record<FooterPresetName, FooterPresetDefinition> = {
  default:  { lines: [["logo", "model", "thinking", "path", "git", "context", "cache", "tools", "statuses"]] },
  compact:  { lines: [["logo", "model", "path", "git", "context", "cache", "statuses"]] },
  minimal:  { lines: [["logo", "path", "git", "context", "statuses"]] },
};

// Helpers

function progressBar(percent: number, barWidth: number, theme: Theme): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * barWidth);
  const empty = barWidth - filled;

  let color: ThemeColor;
  if (clamped < 60) color = "success";
  else if (clamped < 85) color = "warning";
  else color = "error";

  const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
  const label = theme.fg(color, `${Math.round(clamped)}%`);
  return `${bar} ${label}`;
}

function fitLine(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "");
}

const POWERLINE_COLORS: Record<string, { fg: string; bg: string }> = {
  logo:     { fg: "\x1b[38;2;255;255;255m", bg: "\x1b[48;2;0;175;175m" },
  path:     { fg: "\x1b[38;2;255;255;255m", bg: "\x1b[48;2;0;175;175m" },
  model:    { fg: "\x1b[38;2;255;255;255m", bg: "\x1b[48;2;215;135;175m" },
  thinking: { fg: "\x1b[38;2;255;255;255m", bg: "\x1b[48;2;0;135;120m" },
  git:      { fg: "\x1b[38;2;255;255;255m", bg: "\x1b[48;2;200;150;50m" },
  context:  { fg: "\x1b[38;2;255;255;255m", bg: "\x1b[48;2;80;80;80m" },
  dim:      { fg: "\x1b[38;2;255;255;255m", bg: "\x1b[48;2;70;70;70m" },
  success:  { fg: "\x1b[38;2;255;255;255m", bg: "\x1b[48;2;60;130;90m" },
  warning:  { fg: "\x1b[38;2;255;255;255m", bg: "\x1b[48;2;160;110;30m" },
  accent:   { fg: "\x1b[38;2;255;255;255m", bg: "\x1b[48;2;90;90;140m" },
  default:  { fg: "\x1b[39m", bg: "\x1b[49m" },
};

const RESET = "\x1b[0m";

function segmentColor(name: string): { fg: string; bg: string } {
  return POWERLINE_COLORS[name] ?? POWERLINE_COLORS.default;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function getExtensionStatusText(statuses: ReadonlyMap<string, string>): string | null {
  const parts = [...statuses.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => stripAnsi(v).trim())
    .filter((v) => visibleWidth(v) > 0 && !v.includes("thinking:") && !v.includes("💾"));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function renderPowerlineLine(segments: FooterSegment[], width: number, glyphs: FooterGlyphMode): string {
  if (width <= 0 || segments.length === 0) return "";

  const separator = glyphs === "nerd" ? "" : "|";
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const color = segmentColor(seg.color);
    const nextSeg = segments[i + 1];
    const nextColor = nextSeg ? segmentColor(nextSeg.color) : POWERLINE_COLORS.default;

    const icon = seg.icon ? `${seg.icon} ` : "";
    const text = ` ${icon}${seg.text} `;

    parts.push(`${color.fg}${color.bg}${text}`);

    if (i < segments.length - 1) {
      parts.push(`\x1b[38;2;${extractRgb(color.bg)}m${nextColor.bg}${separator}`);
    } else {
      parts.push(`\x1b[38;2;${extractRgb(color.bg)}m\x1b[49m${separator}${RESET}`);
    }
  }

  return fitLine(parts.join(""), width);
}

function extractRgb(bgAnsi: string): string {
  // Extract R;G;B from \x1b[48;2;R;G;Bm
  const match = bgAnsi.match(/48;2;(\d+);(\d+);(\d+)m/);
  return match ? `${match[1]};${match[2]};${match[3]}` : "0;0;0";
}

// RoachFooter

export class RoachFooter implements Component {
  private theme: Theme;
  private footerData: ReadonlyFooterDataProvider;
  private footerCtx: FooterContext;
  private cacheStats: CacheStats;
  private activeTools: ActiveTools;
  private planProgress: PlanProgressTracker | null;
  private tui: Pick<TUI, "requestRender"> | null;
  private milestoneTracker: MilestoneTracker | null;
  private harnessProgress: HarnessProgressProvider | null;
  private preset: FooterPresetName;
  private glyphs: FooterGlyphMode;
  private unsubscribePlanProgress: (() => void) | null = null;
  private unsubscribeMilestone: (() => void) | null = null;
  private unsubscribeHarnessProgress: (() => void) | null = null;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
    footerCtx: FooterContext,
    cacheStats: CacheStats,
    activeTools: ActiveTools,
    planProgress: PlanProgressTracker | null = null,
    tui: Pick<TUI, "requestRender"> | null = null,
    milestoneTracker: MilestoneTracker | null = null,
    harnessProgress: HarnessProgressProvider | null = null,
    options: FooterOptions = {},
  ) {
    this.theme = theme;
    this.footerData = footerData;
    this.footerCtx = footerCtx;
    this.cacheStats = cacheStats;
    this.activeTools = activeTools;
    this.planProgress = planProgress;
    this.milestoneTracker = milestoneTracker;
    this.harnessProgress = harnessProgress;
    this.preset = options.preset ?? "default";
    this.glyphs = options.glyphs ?? (useNerdIcons ? "nerd" : "plain");
    this.tui = tui;
    this.unsubscribePlanProgress = this.planProgress?.subscribeOnChange(() => this.schedulePlanRender()) ?? null;
    this.unsubscribeMilestone = this.milestoneTracker?.subscribeOnChange(() => this.schedulePlanRender()) ?? null;
    this.unsubscribeHarnessProgress = this.harnessProgress?.subscribeOnChange(() => this.schedulePlanRender()) ?? null;
    this.updateSpinnerTimer();
  }

  invalidate() { this.schedulePlanRender(); }

  dispose() {
    if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
    this.unsubscribePlanProgress?.(); this.unsubscribePlanProgress = null;
    this.unsubscribeMilestone?.(); this.unsubscribeMilestone = null;
    this.unsubscribeHarnessProgress?.(); this.unsubscribeHarnessProgress = null;
  }

  private schedulePlanRender() {
    this.updateSpinnerTimer();
    this.tui?.requestRender();
  }

  private hasRunningPlanTasks(): boolean {
    return (this.harnessProgress?.hasState() && this.harnessProgress?.hasRunningTasks())
      || (this.planProgress?.getProgress().running ?? 0) > 0;
  }

  private updateSpinnerTimer() {
    const has = this.hasRunningPlanTasks();
    if (has && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        if (!this.hasRunningPlanTasks()) { this.updateSpinnerTimer(); return; }
        this.tui?.requestRender();
      }, PLAN_PROGRESS_SPINNER_MS);
    } else if (!has && this.spinnerTimer) {
      clearInterval(this.spinnerTimer); this.spinnerTimer = null;
    }
  }

  render(width: number): string[] {
    this.updateSpinnerTimer();
    const normalLines = this.renderNormalFooter(width);
    const border = normalLines[0];

    const hasStructuredMilestones = this.harnessProgress?.hasMilestones() ?? false;
    const hasStructuredPlan = this.harnessProgress?.hasPlan() ?? false;
    const hasMilestones = hasStructuredMilestones || (this.milestoneTracker?.hasMilestones() ?? false);
    const hasPlan = hasStructuredPlan || (this.planProgress?.hasPlan() ?? false);

    if (hasMilestones || hasPlan) {
      const lines: string[] = [border];
      const pw = Math.max(0, width - 4);
      if (hasMilestones) {
        if (hasStructuredMilestones && this.harnessProgress) {
          lines.push(...this.harnessProgress.renderMilestones(this.theme, pw).map((l) => fitLine(l, width)));
        } else if (this.milestoneTracker) {
          lines.push(...this.milestoneTracker.render(this.theme, pw).map((l) => fitLine(l, width)));
        }
        if (hasPlan) lines.push(fitLine(this.theme.fg("dim", "  ·"), width));
      }
      if (hasPlan) {
        if (hasStructuredPlan && this.harnessProgress) {
          lines.push(...this.harnessProgress.renderPlan(this.theme, pw).map((l) => fitLine(l, width)));
        } else if (this.planProgress) {
          lines.push(...this.planProgress.render(this.theme, pw).map((l) => fitLine(l, width)));
        }
      }
      lines.push(...normalLines);
      return lines;
    }
    return normalLines;
  }

  private renderNormalFooter(width: number): string[] {
    const t = this.theme;
    const border = t.fg("dim", "─".repeat(Math.max(0, width)));
    const segments = this.buildSegments();
    const preset = FOOTER_PRESET_DEFINITIONS[this.preset] ?? FOOTER_PRESET_DEFINITIONS.default;
    const renderedLines = preset.lines.map((line) => renderPowerlineLine(this.pickSegments(line, segments), width, this.glyphs));
    return [border, ...renderedLines];
  }

  private pickSegments(ids: FooterSegmentId[], segments: Map<FooterSegmentId, FooterSegment>): FooterSegment[] {
    return ids.map((id) => segments.get(id)).filter((s): s is FooterSegment => !!s);
  }

  private buildSegments(): Map<FooterSegmentId, FooterSegment> {
    const t = this.theme;
    const icons = getIcons(this.glyphs);
    const dirName = basename(this.footerCtx.cwd) || this.footerCtx.cwd;
    const branch = this.footerData.getGitBranch();
    const modelInfo = this.footerCtx.getModelInfo();
    const modelName = modelInfo?.name ?? this.footerCtx.getModelName() ?? "no model";
    const modelDisplay = modelInfo?.isLatest ? `${modelName} (latest)` : modelName;
    const usage = this.footerCtx.getContextUsage();
    const gitStats = this.footerCtx.getGitStats();
    const thinkingLevel = this.footerCtx.getThinkingLevel();

    const pct = usage?.percent ?? 0;
    const tokens = usage?.tokens ?? 0;
    const ctxK = usage ? Math.round(usage.contextWindow / 1000) : 0;
    const tokK = Math.round(tokens / 1000);
    const ctxPart = `${tokK}k/${ctxK}k`;

    const totalTokens = this.cacheStats.totalInput + this.cacheStats.totalCacheRead;
    const cacheRate = totalTokens > 0 ? Math.round((this.cacheStats.totalCacheRead / totalTokens) * 100) : 0;
    let cacheColor: ThemeColor;
    if (cacheRate >= 50) cacheColor = "success";
    else if (cacheRate >= 20) cacheColor = "warning";
    else cacheColor = "dim";

    const segs = new Map<FooterSegmentId, FooterSegment>();

    segs.set("logo", { id: "logo", text: "", icon: icons.logo, color: "logo", priority: 0 });
    segs.set("path", { id: "path", text: dirName, icon: icons.folder, color: "path", priority: 0 });

    if (branch && branch !== "detached") {
      const stats = gitStats;
      let gitText = branch;
      if (stats) {
        const parts: string[] = [];
        if (stats.ahead > 0) parts.push(`⇡${stats.ahead}`);
        if (stats.behind > 0) parts.push(`⇣${stats.behind}`);
        if (stats.dirty > 0) parts.push(`*${stats.dirty}`);
        if (stats.untracked > 0) parts.push(`?${stats.untracked}`);
        if (parts.length > 0) gitText += ` ${parts.join(" ")}`;
      }
      segs.set("git", { id: "git", text: gitText, icon: icons.branch, color: "git", priority: 1 });
    }

    segs.set("model", { id: "model", text: modelDisplay, icon: icons.model, color: "model", priority: 2 });

    if (thinkingLevel && thinkingLevel !== "off") {
      segs.set("thinking", { id: "thinking", text: `thinking:${thinkingLevel}`, icon: icons.thinking, color: "thinking", priority: 3 });
    }

    segs.set("context", { id: "context", text: ctxPart, icon: icons.context, color: "context", priority: 0 });
    segs.set("cache", { id: "cache", text: `cache ${cacheRate}%`, icon: icons.cache, color: cacheColor, priority: 5 });

    const statuses = this.footerData.getExtensionStatuses?.() ?? new Map<string, string>();
    const statusText = getExtensionStatusText(statuses);
    if (statusText) {
      segs.set("statuses", { id: "statuses", text: statusText, icon: icons.status, color: "warning", priority: 1 });
    }

    if (this.activeTools.running.size > 0) {
      const names = [...new Set(this.activeTools.running.values())];
      const count = this.activeTools.running.size;
      segs.set("tools", { id: "tools", text: `${count} ${names.join(",")}`, icon: icons.tool, color: "accent", priority: 4 });
    }

    return segs;
  }
}

// Test exports

export function setUseNerdIcons(value: boolean): void { useNerdIcons = value; }
export { ICONS, ICONS_PLAIN };
