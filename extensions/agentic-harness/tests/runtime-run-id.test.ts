import { describe, expect, it } from "vitest";
import { resolveSessionScopedRunId } from "../runtime-run-id.js";

describe("runtime run id resolution", () => {
  it("uses the pi session id before the shared default run id", () => {
    const ctx = {
      runId: "default",
      sessionManager: {
        getSessionId: () => "abc-123",
      },
    };

    expect(resolveSessionScopedRunId(ctx)).toBe("session-abc-123");
  });

  it("uses an explicit sessionId when no session manager is available", () => {
    expect(resolveSessionScopedRunId({ sessionId: "session-from-context", runId: "default" })).toBe("session-session-from-context");
  });

  it("falls back to runId for non-session contexts", () => {
    expect(resolveSessionScopedRunId({ runId: "worker-run-1" })).toBe("worker-run-1");
  });

  it("keeps the legacy default only when no session identity exists", () => {
    expect(resolveSessionScopedRunId({})).toBe("default");
  });
});
