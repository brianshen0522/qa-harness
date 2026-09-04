import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, type Profile } from "passport-github2";
import { env } from "../../config/env";
import type { OAuthProfile } from "../auth.service";

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, "github") {
  constructor() {
    super({
      clientID: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      callbackURL: `${env.OAUTH_CALLBACK_BASE}/api/auth/github/callback`,
      scope: ["user:email"],
    });
  }

  validate(_at: string, _rt: string, profile: Profile): OAuthProfile {
    const email = profile.emails?.[0]?.value;
    if (!email) throw new Error("GitHub profile has no public email");
    return { provider: "github", email, name: profile.displayName || profile.username || email };
  }
}
