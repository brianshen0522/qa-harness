import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { env } from "../../config/env";

const MAX_AGE_MS = 10 * 60 * 1000;

type Done = (err: Error | null, ok?: string | false, info?: { message: string }) => void;

/**
 * The OAuth `state` value, kept in a short-lived cookie because the app has no
 * server session. Without it a login response can be replayed into a victim's
 * browser, signing them in to the attacker's account.
 */
export class CookieStateStore {
  private readonly cookie: string;

  constructor(provider: string) {
    this.cookie = `qa_oauth_state_${provider}`;
  }

  store(req: Request, done: (err: Error | null, state?: string) => void) {
    const state = randomBytes(24).toString("base64url");
    req.res!.cookie(this.cookie, state, {
      httpOnly: true, sameSite: "lax", secure: env.COOKIE_SECURE, path: "/api/auth", maxAge: MAX_AGE_MS,
    });
    done(null, state);
  }

  verify(req: Request, provided: string, done: Done) {
    const expected = Buffer.from(String(req.cookies?.[this.cookie] ?? ""));
    const actual = Buffer.from(String(provided ?? ""));
    req.res?.clearCookie(this.cookie, { path: "/api/auth" });
    if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      done(null, false, { message: "Invalid OAuth state" });
      return;
    }
    done(null, provided);
  }
}
