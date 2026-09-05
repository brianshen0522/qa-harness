import type { ContentPart, LlmMessage } from "../llm/providers";

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
