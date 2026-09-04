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
