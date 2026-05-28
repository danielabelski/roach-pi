import { describe, expect, it, vi } from "vitest";
import extension from "../index.js";

function loadHarness() {
  const commands = new Map<string, any>();
  const api: any = {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, definition: any) => {
      commands.set(name, definition);
    }),
    sendUserMessage: vi.fn(),
  };

  extension(api);

  const plan = commands.get("plan");
  expect(plan).toBeDefined();

  return { api, commands, plan };
}

function commandContext(confirmed: boolean) {
  return {
    ui: {
      confirm: vi.fn().mockResolvedValue(confirmed),
      setStatus: vi.fn(),
    },
  } as any;
}

describe("Plan milestones mode", () => {
  it("routes explicit milestone planning through /plan", async () => {
    const { api, commands, plan } = loadHarness();
    const removedCommandName = ["ultra", "plan"].join("");

    expect(plan.description).toContain("--milestones");
    expect(commands.has(removedCommandName)).toBe(false);

    await plan.handler("--milestones", commandContext(true));

    expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
    const prompt = api.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain("agentic-milestone-planning");
    expect(prompt).toContain("subagent");
    expect(prompt).toContain("all 3 reviewer");
    expect(prompt).not.toContain("all 5 reviewer");
    expect(prompt).toContain("reviewer-feasibility");
    expect(prompt).toContain("reviewer-architecture");
    expect(prompt).toContain("reviewer-risk");
    expect(prompt).not.toContain("reviewer-dependency");
    expect(prompt).not.toContain("reviewer-user-value");
  });

  it("does not start milestone planning when confirmation is cancelled", async () => {
    const { api, plan } = loadHarness();

    await plan.handler("--milestones", commandContext(false));

    expect(api.sendUserMessage).not.toHaveBeenCalled();
  });
});
