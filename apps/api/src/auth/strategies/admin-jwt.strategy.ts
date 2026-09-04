import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import type { Request } from "express";
import { ADMIN_COOKIE, env } from "../../config/env";
import { PrismaService } from "../../prisma/prisma.service";
import type { AdminPrincipal } from "../../common/types";

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, "admin-jwt") {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => req?.cookies?.[ADMIN_COOKIE] ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: env.ADMIN_JWT_SECRET,
    });
  }

  async validate(payload: { sub: string; kind: string }): Promise<AdminPrincipal> {
    if (payload.kind !== "admin") throw new UnauthorizedException();
    const admin = await this.prisma.admin.findUnique({ where: { id: payload.sub } });
    if (!admin) throw new UnauthorizedException();
    return { kind: "admin", id: admin.id, email: admin.email };
  }
}
