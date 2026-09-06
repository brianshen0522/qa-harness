import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpExecutorService, fillCredentials, redactBody, redactHeaders } from "./http-executor.service";

describe("fillCredentials", () => {
  const creds = { password: "s3cret", token: "abc123" };

  it("substitutes named credentials and leaves unknown ones alone", () => {
    expect(fillCredentials("Bearer {{token}}", creds)).toBe("Bearer abc123");
    expect(fillCredentials('{"password":"{{password}}"}', creds)).toBe('{"password":"s3cret"}');
    expect(fillCredentials("{{ token }}", creds)).toBe("abc123");
    expect(fillCredentials("{{missing}}", creds)).toBe("{{missing}}");
  });

  it("leaves text with no placeholder untouched", () => {
    expect(fillCredentials("plain text", creds)).toBe("plain text");
  });
});

describe("redaction", () => {
  it("masks credential-bearing headers by name", () => {
    expect(redactHeaders({ Authorization: "Bearer abc", "X-Api-Key": "k", accept: "json" })).toEqual({
      Authorization: "****",
      "X-Api-Key": "****",
      accept: "json",
    });
  });

  it("masks credential values wherever they appear in a body", () => {
    const out = redactBody('{"email":"a@b.c","password":"s3cret","note":"s3cret again"}', { password: "s3cret" });
    expect(out).not.toContain("s3cret");
    expect(out).toContain("a@b.c");
    expect(out.match(/\*\*\*\*/g)).toHaveLength(2);
  });

  it("ignores very short credential values, which would mask everything", () => {
    expect(redactBody('{"a":"xy","b":"long"}', { tiny: "xy" })).toContain("xy");
  });
});

describe("HttpExecutorService", () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
  const svc = new HttpExecutorService();

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers as Record<string, string>,
        body,
      });
      if (req.url?.startsWith("/boom")) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end('{"error":"kaboom"}');
      }
      if (req.url?.startsWith("/slow")) {
        return setTimeout(() => res.end("late"), 2000);
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "session=secret-cookie",
      });
      res.end(JSON.stringify({ ok: true, saw: req.url }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it("resolves a relative path against base_url and returns the parsed body", async () => {
    const r = await svc.perform({ method: "GET", path: "todos" }, { base_url: base }, {});
    expect(r.ok).toBe(true);
    expect(r.detail).toMatchObject({ status: 200, body: { ok: true, saw: "/todos" } });
    expect(seen[0].method).toBe("GET");
  });

  it("appends query parameters", async () => {
    await svc.perform({ path: "/todos", query: { tag: "work", done: true } }, { base_url: base }, {});
    expect(seen[0].url).toBe("/todos?tag=work&done=true");
  });

  it("sends a JSON body and fills credentials into it", async () => {
    const r = await svc.perform(
      { method: "POST", path: "/login", body: { email: "a@b.c", password: "{{password}}" } },
      { base_url: base },
      { password: "s3cret" },
    );
    expect(JSON.parse(seen[0].body)).toEqual({ email: "a@b.c", password: "s3cret" });
    expect(seen[0].headers["content-type"]).toContain("application/json");
    // The stored log must not carry the real value.
    expect(r.log.requestBody).not.toContain("s3cret");
    expect(r.log.requestBody).toContain("****");
  });

  it("fills credentials into headers and masks them in the log", async () => {
    const r = await svc.perform(
      { path: "/me", headers: { Authorization: "Bearer {{token}}" } },
      { base_url: base },
      { token: "abc123" },
    );
    expect(seen[0].headers.authorization).toBe("Bearer abc123");
    expect(r.log.requestHeaders.Authorization).toBe("****");
  });

  it("merges target headers with per-request ones", async () => {
    await svc.perform(
      { path: "/x", headers: { "X-Case": "1" } },
      { base_url: base, headers: { "X-Target": "t" } },
      {},
    );
    expect(seen[0].headers["x-target"]).toBe("t");
    expect(seen[0].headers["x-case"]).toBe("1");
  });

  it("treats a 5xx as a valid observation, not an execution failure", async () => {
    const r = await svc.perform({ path: "/boom" }, { base_url: base }, {});
    expect(r.ok).toBe(true);
    expect(r.detail).toMatchObject({ status: 500, body: { error: "kaboom" } });
    expect(r.log.status).toBe(500);
  });

  it("masks credential-bearing response headers", async () => {
    const r = await svc.perform({ path: "/x" }, { base_url: base }, {});
    expect(r.log.responseHeaders["set-cookie"]).toBe("****");
  });

  it("reports a timeout as a failed action with the reason", async () => {
    const r = await svc.perform({ path: "/slow" }, { base_url: base }, {}, 200);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/逾時/);
    expect(r.log.status).toBeNull();
  });

  it("only substitutes credentials for the target's own origin (no cross-origin exfil)", async () => {
    // Same origin as base_url -> filled, and reported as substituted.
    const same = await svc.perform({ url: `${base}/same`, headers: { Authorization: "Bearer {{token}}" } }, { base_url: base }, { token: "abc123456" });
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer abc123456");
    expect(same.substituted).toEqual(["token"]);
    // Different origin than base_url -> the placeholder is NOT filled, the secret
    // never leaves, and nothing is reported as substituted (so a rotation there
    // can never be mistaken for having taken effect).
    const cross = await svc.perform({ url: `${base}/other`, headers: { Authorization: "Bearer {{token}}" } }, { base_url: "http://example.com" }, { token: "abc123456" });
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer {{token}}");
    expect(cross.substituted).toEqual([]);
  });

  it("value-masks a credential in a custom-named request header (not just by name)", async () => {
    const r = await svc.perform({ path: "/x", headers: { "X-Session": "{{token}}" } }, { base_url: base }, { token: "abc123456" });
    expect(seen.at(-1)?.headers["x-session"]).toBe("abc123456"); // really sent
    expect(r.log.requestHeaders["X-Session"]).toBe("****"); // but masked in the stored log
  });

  it("masks a credential value echoed back in the response body", async () => {
    const r = await svc.perform({ path: "/echo/s3cretvalue" }, { base_url: base }, { token: "s3cretvalue" });
    expect(r.log.responseBody).not.toContain("s3cretvalue");
    expect(r.log.responseBody).toContain("****");
  });

  it("explains what is wrong with a url instead of failing opaquely", async () => {
    // The model reads these messages, so they have to say what to do differently.
    expect((await svc.perform({}, { base_url: base }, {})).error).toMatch(/缺少 url 或 path/);
    expect((await svc.perform({ url: "ftp://x/y" }, {}, {})).error).toMatch(/只支援 http\/https，收到的是 ftp/);
    expect((await svc.perform({ path: "/todos" }, {}, {})).error).toMatch(/沒有設定 base_url/);
  });

  it("accepts an absolute url that ignores base_url", async () => {
    const r = await svc.perform({ url: `${base}/absolute` }, { base_url: "http://unused.test" }, {});
    expect(r.ok).toBe(true);
    expect(seen[0].url).toBe("/absolute");
  });
});
