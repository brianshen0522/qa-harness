import { ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/**
 * Admin is a role on the user identity (§ unified auth): authenticate with the
 * normal user cookie, then require the is_admin flag. There is no separate admin
 * login or cookie any more.
 */
@Injectable()
export class AdminGuard extends AuthGuard("user-jwt") {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;
    if (!ok) return false;
    const req = context.switchToHttp().getRequest();
    if (!req.user?.isAdmin) throw new ForbiddenException("需要管理員權限");
    return true;
  }
}
