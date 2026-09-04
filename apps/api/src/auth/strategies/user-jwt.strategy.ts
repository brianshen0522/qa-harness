import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import type { Request } from "express";
import { USER_COOKIE, env } from "../../config/env";
import { PrismaService } from "../../prisma/prisma.service";
import type { UserPrincipal } from "../../common/types";

@Injectable()
export class UserJwtStrategy extends PassportStrategy(Strategy, "user-jwt") {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => req?.cookies?.[USER_COOKIE] ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: env.USER_JWT_SECRET,
    });
  }

  async validate(payload: { sub: string; kind: string }): Promise<UserPrincipal> {
    if (payload.kind !== "user") throw new UnauthorizedException();
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== "active") throw new UnauthorizedException();
    return { kind: "user", id: user.id, email: user.email, name: user.name };
  }
}
