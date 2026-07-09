import { AssistantMessageComponent } from "@mariozechner/pi-coding-agent";

// OpenAI Codex reasoning summaries use empty HTML comments ("<!-- -->") as
// placeholders for withheld summary bodies. They are invisible in HTML-based
// UIs but pi's terminal Markdown renderer prints them literally, so thinking
// traces show bare "<!-- -->" lines under each summary header.
const EMPTY_HTML_COMMENT = /<!--\s*-->/g;

export function stripThinkingPlaceholders(text: string): string {
  if (!text.includes("<!--")) return text;
  const stripped = text.replace(EMPTY_HTML_COMMENT, "");
  if (stripped === text) return text;
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

function sanitizeMessageForDisplay(message: unknown): unknown {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return message;
  let changed = false;
  const sanitized = content.map((block) => {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "thinking" &&
      typeof (block as { thinking?: unknown }).thinking === "string"
    ) {
      const thinking = (block as { thinking: string }).thinking;
      const cleaned = stripThinkingPlaceholders(thinking);
      if (cleaned !== thinking) {
        changed = true;
        return { ...(block as object), thinking: cleaned };
      }
    }
    return block;
  });
  return changed ? { ...(message as object), content: sanitized } : message;
}

let installed = false;

/**
 * Display-only fix: wraps AssistantMessageComponent.updateContent so thinking
 * blocks render without codex placeholder comments. The session entry (and
 * whatever is sent back to the provider) keeps the original text — only the
 * copy handed to the renderer is sanitized.
 */
export function installThinkingPlaceholderFilter(): void {
  if (installed) return;
  let proto: { updateContent?: (message: unknown) => void } | undefined;
  try {
    proto = AssistantMessageComponent?.prototype as unknown as typeof proto;
  } catch {
    // vi.mock module factories throw on exports they don't define; there is
    // no real component to patch in that case.
    return;
  }
  if (!proto || typeof proto.updateContent !== "function") return;
  const original = proto.updateContent;
  proto.updateContent = function (message: unknown) {
    return original.call(this, sanitizeMessageForDisplay(message));
  };
  installed = true;
}
