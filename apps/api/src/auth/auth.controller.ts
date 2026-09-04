import {
  Body, Controller, Get, NotFoundException, Post, Req, Res, UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { IsEmail, IsOptional, IsString } from "class-validator";
import type { Request, Response } from "express";
import { AuthService, type OAuthProfile } from "./auth.service";
import { UserAuthGuard } from "./guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { env } from "../config/env";
import { AuditService } from "../audit/audit.service";

class DevLoginDto {
  @IsEmail() email!: string;
  @IsOptional() @IsString() name?: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly audit: AuditService) {}

  @Get("providers")
  providers() {
    return {
      google: !!env.GOOGLE_CLIENT_ID,
      github: !!env.GITHUB_CLIENT_ID,
      dev: env.DEV_LOGIN_ENABLED,
    };
  }

  @Get("google")
  @UseGuards(AuthGuard("google"))
  google() {}

  @Get("google/callback")
  @UseGuards(AuthGuard("google"))
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    await this.finishOAuth(req.user as OAuthProfile, res);
  }

  @Get("github")
  @UseGuards(AuthGuard("github"))
  github() {}

  @Get("github/callback")
  @UseGuards(AuthGuard("github"))
  async githubCallback(@Req() req: Request, @Res() res: Response) {
    await this.finishOAuth(req.user as OAuthProfile, res);
  }

  /** Development-only login without OAuth. Disabled unless DEV_LOGIN_ENABLED=true. */
  @Post("dev-login")
  async devLogin(@Body() dto: DevLoginDto, @Res({ passthrough: true }) res: Response) {
    if (!env.DEV_LOGIN_ENABLED) throw new NotFoundException();
    const principal = await this.auth.loginUser({ provider: "dev", email: dto.email, name: dto.name ?? dto.email });
    this.auth.setUserCookie(res, principal);
    await this.audit.log("user", principal.id, "auth.login", undefined, { provider: "dev" });
    return principal;
  }

  @Get("me")
  @UseGuards(UserAuthGuard)
  me(@CurrentUser() user: UserPrincipal) {
    return user;
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) res: Response) {
    this.auth.clearUserCookie(res);
    return { ok: true };
  }

  private async finishOAuth(profile: OAuthProfile, res: Response) {
    const principal = await this.auth.loginUser(profile);
    this.auth.setUserCookie(res, principal);
    await this.audit.log("user", principal.id, "auth.login", undefined, { provider: profile.provider });
    res.redirect(env.WEB_ORIGIN);
  }
}
