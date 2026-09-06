import type { ContentPart, LlmMessage } from "../llm/providers";
import type { PageProbe } from "../sandbox/computer.service";

/** Screenshots kept in the prompt; older steps keep their text only, to bound cost. */
export const SCREENSHOT_WINDOW = 3;

/** Build the per-step message list, keeping images only on the last SCREENSHOT_WINDOW
 *  turns plus the current screenshot — older turns are reduced to their text. */
export function buildMessages(
  turns: { assistant: string; user: ContentPart[] }[],
  screenshot: string | null,
  seq: number,
  maxSteps: number,
): LlmMessage[] {
  const messages: LlmMessage[] = [];
  const imageFrom = Math.max(0, turns.length - SCREENSHOT_WINDOW);
  turns.forEach((turn, i) => {
    messages.push({ role: "assistant", content: turn.assistant });
    messages.push({
      role: "user",
      content: i >= imageFrom ? turn.user : turn.user.filter((p) => p.type === "text"),
    });
  });
  const text = `這是第 ${seq} / ${maxSteps} 步。請決定下一個動作。`;
  messages.push({
    role: "user",
    content: screenshot
      ? [{ type: "image", mediaType: "image/png", base64: screenshot }, { type: "text", text }]
      : text,
  });
  return messages;
}

/** Replace each secret string with **** anywhere in a serializable value, matching
 *  its JSON-escaped form so secrets containing quotes/newlines are still caught. */
export function maskSecrets<T>(value: T, secrets: string[]): T {
  if (!secrets.length) return value;
  try {
    let json = JSON.stringify(value);
    for (const secret of secrets) {
      if (!secret) continue;
      json = json.split(JSON.stringify(secret).slice(1, -1)).join("****");
    }
    return JSON.parse(json) as T;
  } catch {
    return value;
  }
}

/**
 * Trim a DOM probe to what the agent needs to choose its next action. The raw
 * probe on a real page can be hundreds of links; feeding all of it back on every step
 * would blow the context budget for no gain.
 */
export function summariseProbe(p: PageProbe): Record<string, unknown> {
  const cap = <T>(xs: T[], n: number) => xs.slice(0, n);
  return {
    path: p.path,
    title: p.title,
    headings: cap(p.headings, 12),
    links: cap(p.links.filter((l) => l.visible && l.text.trim()), 40).map((l) => ({ text: l.text.trim().slice(0, 80), href: l.href })),
    forms: cap(p.forms, 6).map((f) => ({
      action: f.action, method: f.method,
      fields: cap(f.fields, 20).map((x) => ({ name: x.name, type: x.type, label: x.label, required: x.required })),
    })),
    controls: cap(p.controls.filter((c) => c.text.trim()), 30).map((c) => ({ text: c.text.trim().slice(0, 60), role: c.role, disabled: c.disabled })),
    dialogs: p.dialogs,
    overlay: p.overlay,
    horizontalOverflow: p.scrollWidth > p.clientWidth + 1,
  };
}
