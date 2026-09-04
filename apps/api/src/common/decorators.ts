import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AdminPrincipal, UserPrincipal } from "./types";

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): UserPrincipal => {
  return ctx.switchToHttp().getRequest().user;
});

export const CurrentAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext): AdminPrincipal => {
  return ctx.switchToHttp().getRequest().user;
});
