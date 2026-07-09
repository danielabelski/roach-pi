import { beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageComponent, initTheme } from "@mariozechner/pi-coding-agent";
import {
  installThinkingPlaceholderFilter,
  stripThinkingPlaceholders,
} from "../thinking-placeholder-filter.js";

beforeAll(() => {
  initTheme("dark", false);
});

// OpenAI Codex reasoning summaries arrive as "**Header**\n\n<!-- -->" parts —
// the empty HTML comment is a placeholder for a withheld summary body.
const CODEX_THINKING =
  "**Clarifying evidence and verifier workflow**\n\n<!-- -->\n\n**Evaluating independent verifier invocation options**\n\n<!-- -->";

function renderPlain(message: unknown): string {
  const component = new AssistantMessageComponent(message as never);
  return component
    .render(100)
    .map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""))
    .join("\n");
}

function codexMessage() {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: CODEX_THINKING }],
    stopReason: "stop",
  };
}

describe("stripThinkingPlaceholders", () => {
  it("removes empty HTML comment placeholders and collapses leftover blank lines", () => {
    expect(stripThinkingPlaceholders(CODEX_THINKING)).toBe(
      "**Clarifying evidence and verifier workflow**\n\n**Evaluating independent verifier invocation options**",
    );
  });

  it("leaves thinking text without placeholders untouched", () => {
    const text = "Plain reasoning.\n\nWith two paragraphs.";
    expect(stripThinkingPlaceholders(text)).toBe(text);
  });

  it("does not remove non-empty HTML comments", () => {
    const text = "before <!-- keep me --> after";
    expect(stripThinkingPlaceholders(text)).toBe(text);
  });
});

describe("installThinkingPlaceholderFilter", () => {
  it("renders codex placeholder-only summary bodies without literal <!-- -->", () => {
    // Characterize the unpatched behavior first so the guard proves the
    // filter (and not something else) removes the placeholder.
    expect(renderPlain(codexMessage())).toContain("<!-- -->");

    installThinkingPlaceholderFilter();
    const patched = renderPlain(codexMessage());
    expect(patched).not.toContain("<!-- -->");
    expect(patched).toContain("Clarifying evidence and verifier workflow");
    expect(patched).toContain("Evaluating independent verifier invocation options");
  });

  it("does not mutate the stored message content", () => {
    installThinkingPlaceholderFilter();
    const message = codexMessage();
    renderPlain(message);
    expect((message.content[0] as { thinking: string }).thinking).toBe(CODEX_THINKING);
  });

  it("is idempotent when installed twice", () => {
    installThinkingPlaceholderFilter();
    installThinkingPlaceholderFilter();
    expect(renderPlain(codexMessage())).not.toContain("<!-- -->");
  });
});
