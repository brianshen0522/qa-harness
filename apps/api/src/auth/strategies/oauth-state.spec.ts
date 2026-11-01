process.env.DATABASE_URL ??= "postgresql://x:x@127.0.0.1:1/x";
process.env.USER_JWT_SECRET ??= "test";
process.env.CREDENTIAL_MASTER_KEY ??= "test";

import type { Request } from "express";
import { CookieStateStore } from "./oauth-state.store";
import { verifiedGithubEmail } from "./github.strategy";

function fakeReq(cookies: Record<string, string> = {}) {
  const set: Record<string, string> = {};
  const res = {
    cookie: (name: string, value: string) => { set[name] = value; },
    clearCookie: jest.fn(),
  };
  return { req: { cookies, res } as unknown as Request, set, res };
}

describe("CookieStateStore", () => {
  const store = new CookieStateStore("github");
  const name = "qa_oauth_state_github";

  function issue(): string {
    const { req, set } = fakeReq();
    let state = "";
    store.store(req, (_e, s) => { state = s!; });
    expect(set[name]).toBe(state);
    expect(state.length).toBeGreaterThan(20);
    return state;
  }

  const verify = (cookie: string | undefined, provided: string) => {
    const { req, res } = fakeReq(cookie ? { [name]: cookie } : {});
    let ok: string | false | undefined;
    store.verify(req, provided, (_e, r) => { ok = r; });
    expect(res.clearCookie).toHaveBeenCalled();
    return ok;
  };

  it("accepts the state it issued to this browser", () => {
    const state = issue();
    expect(verify(state, state)).toBe(state);
  });

  it("refuses a missing cookie, a mismatch and an empty state", () => {
    const state = issue();
    expect(verify(undefined, state)).toBe(false);
    expect(verify(state, issue())).toBe(false);
    expect(verify(undefined, "")).toBe(false);
  });
});

describe("verifiedGithubEmail", () => {
  it("prefers the verified primary address", () => {
    expect(verifiedGithubEmail({ emails: [
      { value: "other@x.test", verified: true, primary: false },
      { value: "main@x.test", verified: true, primary: true },
    ] as never })).toBe("main@x.test");
  });

  it("never returns an unverified address, even a primary one", () => {
    expect(verifiedGithubEmail({ emails: [{ value: "admin@x.test", verified: false, primary: true }] as never })).toBeUndefined();
    expect(verifiedGithubEmail({ emails: [{ value: "public@x.test" }] as never })).toBeUndefined();
    expect(verifiedGithubEmail({})).toBeUndefined();
  });
});
