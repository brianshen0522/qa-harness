import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, type Profile } from "passport-github2";
import { env } from "../../config/env";
import type { OAuthProfile } from "../auth.service";
import { CookieStateStore } from "./oauth-state.store";

/** GitHub lets anyone claim an address they do not own until it is verified. */
export function verifiedGithubEmail(profile: Pick<Profile, "emails">): string | undefined {
  const emails = (profile.emails ?? []) as { value: string; primary?: boolean; verified?: boolean }[];
  const verified = emails.filter((e) => e.verified === true);
  return (verified.find((e) => e.primary) ?? verified[0])?.value;
}

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, "github") {
  constructor() {
    super({
      clientID: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      callbackURL: `${env.OAUTH_CALLBACK_BASE}/api/auth/github/callback`,
      scope: ["user:email"],
      allRawEmails: true,
      store: new CookieStateStore("github"),
    } as never);
  }

  validate(_at: string, _rt: string, profile: Profile): OAuthProfile {
    const email = verifiedGithubEmail(profile);
    if (!email) throw new UnauthorizedException("GitHub account has no verified email");
    return { provider: "github", email, name: profile.displayName || profile.username || email };
  }
}
