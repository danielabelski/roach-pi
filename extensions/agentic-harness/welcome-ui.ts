import type { Component, TUI } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint, keyText, rawKeyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

export type HeaderFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

export type HeaderUi = {
  setHeader: (factory: HeaderFactory | undefined) => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
};

let welcomeVisible = true;

export function createWelcomeHeader(): HeaderFactory {
  return (_tui, theme) => {
    const banner = [
      "██████╗  ██████╗  █████╗  ██████╗██╗  ██╗    ██████╗ ██╗",
      "██╔══██╗██╔═══██╗██╔══██╗██╔════╝██║  ██║    ██╔══██╗██║",
      "██████╔╝██║   ██║███████║██║     ███████║    ██████╔╝██║",
      "██╔══██╗██║   ██║██╔══██║██║     ██╔══██║    ██╔═══╝ ██║",
      "██║  ██║╚██████╔╝██║  ██║╚██████╗██║  ██║    ██║     ██║",
      "╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝    ╚═╝     ╚═╝",
    ].map((line) => theme.bold(theme.fg("accent", line))).join("\n");

    const tagline = theme.fg("dim", "Engineering Discipline Extension");
    const tipLine = theme.fg("muted", "Tip: Always start with /clarify. Then use /plan or /plan --milestones.");
    const clarifyLine = theme.fg("dim", "Never skip /clarify — it prevents wasted effort.");
    const hints = [
      keyHint("app.interrupt", "to interrupt"),
      keyHint("app.clear", "to clear"),
      rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
      keyHint("app.tools.expand", "to expand tools"),
      rawKeyHint("/", "for commands"),
      rawKeyHint("!", "to run bash"),
    ].join("\n");

    return new Text(`\n${banner}\n${tagline}\n\n${tipLine}\n${clarifyLine}\n\n${hints}`, 1, 0);
  };
}

export function showWelcomeHeader(ui: HeaderUi): void {
  welcomeVisible = true;
  ui.setHeader(createWelcomeHeader());
}

export function dismissWelcomeHeader(ui: HeaderUi): void {
  welcomeVisible = false;
  ui.setHeader(undefined);
}

export function toggleWelcomeHeader(ui: HeaderUi): boolean {
  if (welcomeVisible) {
    dismissWelcomeHeader(ui);
    return false;
  }
  showWelcomeHeader(ui);
  return true;
}

export function isWelcomeVisible(): boolean {
  return welcomeVisible;
}

export function registerWelcomeCommand(pi: ExtensionAPI): void {
  pi.registerCommand("welcome", {
    description: "Show, hide, or toggle the Agentic Harness welcome header",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui as HeaderUi;
      const action = args.trim().toLowerCase();
      if (action === "off" || action === "hide" || action === "dismiss") {
        dismissWelcomeHeader(ui);
        ui.notify?.("Welcome header hidden", "info");
        return;
      }
      if (action === "on" || action === "show" || action === "restore") {
        showWelcomeHeader(ui);
        ui.notify?.("Welcome header shown", "info");
        return;
      }
      const visible = toggleWelcomeHeader(ui);
      ui.notify?.(visible ? "Welcome header shown" : "Welcome header hidden", "info");
    },
  });
}
