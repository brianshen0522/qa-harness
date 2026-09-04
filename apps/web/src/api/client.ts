export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type Body = Record<string, unknown> | unknown[] | undefined;

export async function api<T>(
  path: string,
  init?: Omit<RequestInit, "body"> & { body?: Body },
): Promise<T> {
  const headers = new Headers(init?.headers);
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    body,
    credentials: "include",
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    if (data && typeof data === "object" && "message" in data) {
      const m = (data as { message: unknown }).message;
      if (Array.isArray(m)) message = m.join("; ");
      else if (typeof m === "string") message = m;
    } else if (typeof data === "string" && data) {
      message = data;
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * POSTs a JSON body and yields the parsed payload of every `data:` line of a
 * `text/event-stream` response. `EventSource` cannot be used for these streams
 * because it only ever issues a GET without a body. Pass an `AbortSignal` to
 * stop the run — closing the connection aborts it server-side too.
 */
export async function* apiEventStream<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let message = res.statusText || `HTTP ${res.status}`;
    if (text) {
      message = text;
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        const m = parsed?.message;
        if (Array.isArray(m)) message = m.join("; ");
        else if (typeof m === "string") message = m;
      } catch {
        /* keep the raw body as the message */
      }
    }
    throw new ApiError(res.status, message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      yield JSON.parse(payload) as T;
    }
  }
}
