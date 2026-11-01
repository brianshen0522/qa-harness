import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, type Profile } from "passport-google-oauth20";
import { env } from "../../config/env";
import type { OAuthProfile } from "../auth.service";
import { CookieStateStore } from "./oauth-state.store";

/** Accounts match by email, so an unverified one could claim someone else's. */
export function verifiedGoogleEmail(profile: Pick<Profile, "emails">): string | undefined {
  const primary = profile.emails?.[0] as { value: string; verified?: boolean | string } | undefined;
  return primary?.verified === true || primary?.verified === "true" ? primary.value : undefined;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
  constructor() {
    super({
      clientID: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${env.OAUTH_CALLBACK_BASE}/api/auth/google/callback`,
      scope: ["email", "profile"],
      store: new CookieStateStore("google"),
    } as never);
  }

  validate(_at: string, _rt: string, profile: Profile): OAuthProfile {
    const email = verifiedGoogleEmail(profile);
    if (!email) throw new UnauthorizedException("Google account has no verified email");
    return { provider: "google", email, name: profile.displayName ?? email };
  }
}
