import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { UserPrincipal } from "./types";

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): UserPrincipal => {
  return ctx.switchToHttp().getRequest().user;
});

/** Same principal as CurrentUser; kept for admin-only routes for readability. */
export const CurrentAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext): UserPrincipal => {
  return ctx.switchToHttp().getRequest().user;
});
