import { Body, Controller, Get, Post, Res, UseGuards } from "@nestjs/common";
import { IsEmail, IsString, MinLength } from "class-validator";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import { AdminAuthGuard } from "./guards/admin-auth.guard";
import { CurrentAdmin } from "../common/decorators";
import type { AdminPrincipal } from "../common/types";
import { AuditService } from "../audit/audit.service";

class AdminLoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) password!: string;
}

@Controller("admin/auth")
export class AdminAuthController {
  constructor(private readonly auth: AuthService, private readonly audit: AuditService) {}

  @Post("login")
  async login(@Body() dto: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    const admin = await this.auth.loginAdmin(dto.email, dto.password);
    this.auth.setAdminCookie(res, admin);
    await this.audit.log("admin", admin.id, "admin.login");
    return admin;
  }

  @Get("me")
  @UseGuards(AdminAuthGuard)
  me(@CurrentAdmin() admin: AdminPrincipal) {
    return admin;
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) res: Response) {
    this.auth.clearAdminCookie(res);
    return { ok: true };
  }
}
