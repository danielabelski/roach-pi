import { describe, expect, it } from "vitest";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { ReadonlyFooterDataProvider } from "@mariozechner/pi-coding-agent";
import { ICONS, RoachFooter, setUseNerdIcons } from "../footer.js";

setUseNerdIcons(false);

const stubTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: (_color: string) => "",
} as any;

const ansiTheme = {
  fg: (color: string, text: string) => `${ansiTheme.getFgAnsi(color)}${text}\x1b[39m`,
  bold: (text: string) => text,
  getFgAnsi: (color: string) => {
    const codes: Record<string, number> = {
      accent: 33, success: 34, warning: 35, error: 196, dim: 238, text: 15,
    };
    return `\x1b[38;5;${codes[color] ?? 15}m`;
  },
} as any;

function footerData(statuses: ReadonlyMap<string, string> = new Map()): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => "main",
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  };
}

function createFooter(
  statuses: ReadonlyMap<string, string> = new Map(),
  preset: "default" | "compact" | "minimal" = "default",
  gitStats = { ahead: 0, behind: 0, dirty: 0, untracked: 0 },
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined = "high",
  modelInfo = { name: "test-model", isLatest: false }
): RoachFooter {
  return new RoachFooter(
    stubTheme,
    footerData(statuses),
    {
      cwd: "/tmp/powerline-project",
      getModelName: () => modelInfo.name,
      getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
      getGitStats: () => gitStats,
      getThinkingLevel: () => thinkingLevel,
      getModelInfo: () => modelInfo,
    },
    { totalInput: 100, totalCacheRead: 50 },
    { running: new Map([["tool-1", "read"]]) },
    null,
    null,
    null,
    { preset },
  );
}

function expectAllLinesFit(lines: string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}

describe("RoachFooter Powerline styling", () => {
  it("renders concrete Nerd Font icons and the Powerline segment separator", () => {
    setUseNerdIcons(true);
    try {
      expect(Object.values(ICONS).every((icon) => icon.length > 0)).toBe(true);

      const rendered = createFooter().render(100).join("\n");

      expect(rendered).toContain("");
      expect(rendered).toContain(ICONS.folder);
      expect(rendered).toContain(ICONS.branch);
      expect(rendered).toContain(ICONS.model);
      expect(rendered).toContain(ICONS.logo);
      expect(rendered).toContain(ICONS.thinking);
    } finally {
      setUseNerdIcons(false);
    }
  });

  it("renders solid background blocks with 48;2 ANSI sequences", () => {
    const footer = new RoachFooter(
      ansiTheme,
      footerData(),
      {
        cwd: "/tmp/powerline-project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
        getGitStats: () => ({ ahead: 0, behind: 0, dirty: 0, untracked: 0 }),
        getThinkingLevel: () => "high",
        getModelInfo: () => ({ name: "test-model", isLatest: false }),
      },
      { totalInput: 100, totalCacheRead: 50 },
      { running: new Map() },
    );

    const rendered = footer.render(100).join("\n");

    expect(rendered).toContain("\x1b[48;2;0;175;175m");
    expect(rendered).toContain("\x1b[48;2;215;135;175m");
    expect(rendered).toContain("\x1b[48;2;200;150;50m");
    expect(rendered).toContain("");
  });
});

describe("RoachFooter status bridge", () => {
  it("renders the base footer without extension statuses", () => {
    const footer = createFooter();
    const lines = footer.render(80);

    expect(lines.length).toBe(3);
    const rendered = lines.join("\n");
    expect(rendered).toContain("powerline-project");
    expect(rendered).toContain("main");
    expect(rendered).toContain("test-model");
    expect(rendered).toContain("thinking:high");
    expect(rendered).toContain("ctx");
    expect(rendered).toContain("cache 33%");
    expect(rendered).toContain("read");
    expectAllLinesFit(lines, 80);
  });

  it("renders one extension status from footerData.getExtensionStatuses", () => {
    const footer = createFooter(new Map([["harness", "Team running"]]));
    const lines = footer.render(100);

    expect(lines.join("\n")).toContain("Team running");
    expectAllLinesFit(lines, 100);
  });

  it("renders multiple extension statuses in stable key order", () => {
    const footer = createFooter(new Map([
      ["zeta", "Zed status"],
      ["alpha", "Alpha status"],
    ]));
    const rendered = footer.render(120).join("\n");

    expect(rendered).toContain("Alpha status");
    expect(rendered).toContain("Zed status");
    expect(rendered.indexOf("Alpha status")).toBeLessThan(rendered.indexOf("Zed status"));
  });

  it("ignores empty and whitespace-only extension statuses", () => {
    const footer = createFooter(new Map([
      ["empty", ""],
      ["spaces", "   "],
      ["ready", "Ready"],
    ]));
    const rendered = footer.render(100).join("\n");

    expect(rendered).toContain("Ready");
    expect(rendered).not.toContain("empty");
    expect(rendered).not.toContain("spaces");
  });

  it("truncates long extension statuses without exceeding width", () => {
    const footer = createFooter(new Map([
      ["harness", "Deploying a very long background operation that should be truncated safely"],
    ]));
    const width = 44;
    const lines = footer.render(width);

    expect(lines.join("\n")).toContain("Dep");
    expectAllLinesFit(lines, width);
  });

  it("keeps every normal footer line within narrow render widths", () => {
    const footer = createFooter(new Map([
      ["harness", "Narrow status"],
      ["memory", "Memory warm"],
    ]));

    for (const width of [24, 32, 40, 60]) {
      expectAllLinesFit(footer.render(width), width);
    }
  });

  it("renders distinct default, compact, and minimal preset layouts", () => {
    const statuses = new Map([["harness", "Ready"]]);
    const defaultLines = createFooter(statuses, "default").render(150);
    const compactLines = createFooter(statuses, "compact").render(150);
    const minimalLines = createFooter(statuses, "minimal").render(150);

    expect(defaultLines.length).toBe(3);
    expect(compactLines.length).toBe(2);
    expect(minimalLines.length).toBe(2);
    expect(defaultLines.join("\n")).toContain("ctx");
    expect(compactLines.join("\n")).toContain("ctx");
    expect(minimalLines.join("\n")).not.toContain("ctx");
    expect(minimalLines.join("\n")).not.toContain("test-model");
    expect(defaultLines.join("\n")).toContain("Ready");
    expect(compactLines.join("\n")).toContain("Ready");
    expect(minimalLines.join("\n")).toContain("Ready");
  });

  it("keeps every preset width-safe at narrow and normal widths", () => {
    const statuses = new Map([["harness", "Preset status that may need truncation"]]);

    for (const preset of ["default", "compact", "minimal"] as const) {
      for (const width of [28, 44, 100]) {
        expectAllLinesFit(createFooter(statuses, preset).render(width), width);
      }
    }
  });

  it("renders git stats when available", () => {
    const footer = createFooter(new Map(), "default", { ahead: 3, behind: 0, dirty: 5, untracked: 2 });
    const rendered = footer.render(100).join("\n");

    expect(rendered).toContain("⇡3");
    expect(rendered).toContain("*5");
    expect(rendered).toContain("?2");
  });

  it("renders model with (latest) tag when isLatest is true", () => {
    const footer = createFooter(new Map(), "default", { ahead: 0, behind: 0, dirty: 0, untracked: 0 }, "high", { name: "Opus 4.5", isLatest: true });
    const rendered = footer.render(100).join("\n");

    expect(rendered).toContain("Opus 4.5 (latest)");
  });

  it("hides thinking segment when level is off", () => {
    const footer = createFooter(new Map(), "default", { ahead: 0, behind: 0, dirty: 0, untracked: 0 }, "off");
    const rendered = footer.render(100).join("\n");

    expect(rendered).not.toContain("thinking:");
  });
});
