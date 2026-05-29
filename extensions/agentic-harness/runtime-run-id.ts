export function resolveSessionScopedRunId(ctx: unknown, fallback = "default"): string {
  const context = isRecord(ctx) ? ctx : undefined;
  const sessionManager = isRecord(context?.sessionManager) ? context.sessionManager : undefined;
  const getSessionId = sessionManager?.getSessionId;

  if (typeof getSessionId === "function") {
    const sessionId = getSessionId.call(sessionManager);
    if (typeof sessionId === "string" && sessionId.trim()) {
      return `session-${sessionId.trim()}`;
    }
  }

  const sessionId = context?.sessionId;
  if (typeof sessionId === "string" && sessionId.trim()) {
    return `session-${sessionId.trim()}`;
  }

  const runId = context?.runId;
  if (typeof runId === "string" && runId.trim()) {
    return runId.trim();
  }

  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
