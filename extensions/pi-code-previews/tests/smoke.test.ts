import { describe, expect, it } from "vitest";
import { escapeControlChars, stripAnsi } from "../src/terminal-text.ts";

describe("terminal text helpers", () => {
  it("strips ansi and makes control characters visible", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(escapeControlChars("a\rb\u001b[31m")).toBe("a␍b␛[31m");
  });
});
