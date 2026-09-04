import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, type Profile } from "passport-google-oauth20";
import { env } from "../../config/env";
import type { OAuthProfile } from "../auth.service";

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
  constructor() {
    super({
      clientID: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${env.OAUTH_CALLBACK_BASE}/api/auth/google/callback`,
      scope: ["email", "profile"],
    });
  }

  validate(_at: string, _rt: string, profile: Profile): OAuthProfile {
    const email = profile.emails?.[0]?.value;
    if (!email) throw new Error("Google profile has no email");
    return { provider: "google", email, name: profile.displayName ?? email };
  }
}
