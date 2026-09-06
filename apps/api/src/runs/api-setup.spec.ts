import { ApiSetupService, extractPath, type SetupStep } from "./api-setup.service";
import type { HttpActionResult } from "./http-executor.service";

describe("extractPath", () => {
  const detail = {
    status: 200,
    headers: { location: "/users/7" },
    body: { data: { token: "jwt-abc" }, list: [{ id: 1 }, { id: 2 }] },
  };
  it("reads nested body values", () => {
    expect(extractPath(detail, "body.data.token")).toBe("jwt-abc");
  });
  it("reads top-level status and header", () => {
    expect(extractPath(detail, "status")).toBe(200);
    expect(extractPath(detail, "headers.location")).toBe("/users/7");
  });
  it("indexes into arrays", () => {
    expect(extractPath(detail, "body.list.1.id")).toBe(2);
  });
  it("returns undefined for a missing path", () => {
    expect(extractPath(detail, "body.nope.deep")).toBeUndefined();
  });
});

describe("ApiSetupService.run", () => {
  function svcWith(results: HttpActionResult[]) {
    const calls: { params: Record<string, unknown>; vars: Record<string, string> }[] = [];
    let i = 0;
    const http = {
      perform: async (params: Record<string, unknown>, _cfg: unknown, vars: Record<string, string>) => {
        calls.push({ params, vars });
        return results[i++];
      },
    };
    // Only `http` is used by run(); the other deps are irrelevant here.
    const svc = new ApiSetupService(null as never, null as never, http as never);
    return { svc, calls };
  }
  const ok = (detail: Record<string, unknown>): HttpActionResult => ({
    ok: true, durationMs: 1, detail, log: {} as never, substituted: [],
  });

  it("captures a token from step 1 and exposes it to step 2", async () => {
    const { svc, calls } = svcWith([
      ok({ status: 200, body: { access_token: "T0K3N" } }),
      ok({ status: 200, body: {} }),
    ]);
    const steps: SetupStep[] = [
      { label: "login", request: { method: "POST", path: "/login" }, captures: [{ name: "token", from: "body.access_token" }] },
      { label: "me", request: { method: "GET", path: "/me", headers: { Authorization: "Bearer {{token}}" } }, captures: [] },
    ];
    const out = await svc.run(steps, { base_url: "http://x" }, { password: "pw" });
    expect(out.ok).toBe(true);
    expect(out.captured).toEqual({ token: "T0K3N" });
    // Step 2 saw the captured token merged onto the base credentials.
    expect(calls[1].vars).toMatchObject({ password: "pw", token: "T0K3N" });
    expect(out.steps[0].captured).toEqual(["token"]);
  });

  it("fails the flow when a capture path is missing", async () => {
    const { svc } = svcWith([ok({ status: 200, body: {} })]);
    const steps: SetupStep[] = [
      { label: "login", request: { method: "POST", path: "/login" }, captures: [{ name: "token", from: "body.access_token" }] },
    ];
    const out = await svc.run(steps, { base_url: "http://x" }, {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain("找不到");
    expect(out.captured.token).toBeUndefined();
  });

  it("stops at the first failing request", async () => {
    const { svc, calls } = svcWith([
      { ok: false, durationMs: 1, error: "連線被拒", detail: {}, log: {} as never, substituted: [] },
      ok({ status: 200, body: {} }),
    ]);
    const steps: SetupStep[] = [
      { label: "login", request: { method: "POST", path: "/login" }, captures: [] },
      { label: "next", request: { method: "GET", path: "/x" }, captures: [] },
    ];
    const out = await svc.run(steps, { base_url: "http://x" }, {});
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(out.steps[0].error).toContain("連線被拒");
  });
});
