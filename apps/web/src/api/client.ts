export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type Body = Record<string, unknown> | unknown[] | undefined;

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The Nest error envelope is `{ message: string | string[] }`; fall back to the status line. */
function failureMessage(res: Response, data: unknown): string {
  if (data && typeof data === "object" && "message" in data) {
    const m = (data as { message: unknown }).message;
    if (Array.isArray(m)) return m.join("; ");
    if (typeof m === "string") return m;
  } else if (typeof data === "string" && data) {
    return data;
  }
  return res.statusText || `HTTP ${res.status}`;
}

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

  const data = parseBody(await res.text());
  if (!res.ok) throw new ApiError(res.status, failureMessage(res, data));
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Opens an `EventSource` on an API path. The agent transcript is served as SSE
 * over a GET on the same origin (through the Vite proxy in dev), so the session
 * cookie rides along and `EventSource` — which can only issue a GET — is enough.
 * It reconnects by itself; the caller closes it and reads `readyState` to tell a
 * reconnect apart from a stream the browser has given up on.
 */
export function apiEventSource(path: string): EventSource {
  return new EventSource(`/api${path}`, { withCredentials: true });
}

/**
 * Consumes an SSE stream served over a POST — `EventSource` can only issue a GET,
 * so the generation pipeline (spec §4.3) is read straight off `response.body`.
 * Permission and conflict errors are raised before the stream starts and arrive
 * as an ordinary JSON error, so they come back as an `ApiError` the caller can
 * show verbatim. The promise settles when the server closes the stream; pass a
 * `signal` to hang up early.
 */
export async function apiEventStream<T>(
  path: string,
  init: Omit<RequestInit, "body"> & { body?: Body },
  onEvent: (event: T) => void,
): Promise<void> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "text/event-stream");
  let body: string | undefined;
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    method: init.method ?? "POST",
    headers,
    body,
    credentials: "include",
  });

  if (!res.ok) {
    const data = parseBody(await res.text());
    throw new ApiError(res.status, failureMessage(res, data));
  }
  if (!res.body) throw new ApiError(res.status, "瀏覽器無法讀取這個串流回應。");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const drain = (flush: boolean) => {
    // Frames are separated by a blank line; keep the tail until its blank line lands.
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      emit(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
    }
    if (flush && buffer.trim()) {
      emit(buffer);
      buffer = "";
    }
  };
  const emit = (frame: string) => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload) as T);
      } catch {
        /* a malformed frame is not worth tearing the stream down over */
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      drain(false);
    }
    buffer += decoder.decode().replace(/\r\n/g, "\n");
    drain(true);
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
