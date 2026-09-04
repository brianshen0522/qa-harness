import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { ADMIN_COOKIE, USER_COOKIE, env } from "../config/env";
import type { AdminPrincipal, UserPrincipal } from "../common/types";

export interface OAuthProfile {
  provider: "google" | "github" | "dev";
  email: string;
  name: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  /** Find-or-create the user for an OAuth login. Disabled users are rejected. */
  async loginUser(profile: OAuthProfile): Promise<UserPrincipal> {
    const email = profile.email.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await this.prisma.user.create({
        data: { email, name: profile.name || email, authProvider: profile.provider },
      });
    } else if (user.status === "disabled") {
      throw new UnauthorizedException("Account disabled");
    }
    return { kind: "user", id: user.id, email: user.email, name: user.name };
  }

  async loginAdmin(email: string, password: string): Promise<AdminPrincipal> {
    const admin = await this.prisma.admin.findUnique({ where: { email: email.toLowerCase() } });
    if (!admin || !(await argon2.verify(admin.passwordHash, password))) {
      throw new UnauthorizedException("Invalid credentials");
    }
    return { kind: "admin", id: admin.id, email: admin.email };
  }

  signUser(p: UserPrincipal) {
    return this.jwt.sign({ sub: p.id, email: p.email, name: p.name, kind: "user" }, {
      secret: env.USER_JWT_SECRET,
      expiresIn: "7d",
    });
  }

  signAdmin(p: AdminPrincipal) {
    return this.jwt.sign({ sub: p.id, email: p.email, kind: "admin" }, {
      secret: env.ADMIN_JWT_SECRET,
      expiresIn: "12h",
    });
  }

  setUserCookie(res: Response, p: UserPrincipal) {
    res.cookie(USER_COOKIE, this.signUser(p), this.cookieOpts(7 * 24 * 3600 * 1000));
  }
  setAdminCookie(res: Response, p: AdminPrincipal) {
    res.cookie(ADMIN_COOKIE, this.signAdmin(p), this.cookieOpts(12 * 3600 * 1000));
  }
  clearUserCookie(res: Response) {
    res.clearCookie(USER_COOKIE, this.cookieOpts(0));
  }
  clearAdminCookie(res: Response) {
    res.clearCookie(ADMIN_COOKIE, this.cookieOpts(0));
  }

  private cookieOpts(maxAge: number) {
    return { httpOnly: true, sameSite: "lax" as const, secure: env.COOKIE_SECURE, path: "/", maxAge };
  }
}
