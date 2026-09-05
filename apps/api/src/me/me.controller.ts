import { Controller, Get, UseGuards } from "@nestjs/common";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { MeService } from "./me.service";

@Controller("me")
@UseGuards(UserAuthGuard)
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get("runs")
  runs(@CurrentUser() user: UserPrincipal) {
    return this.me.myRuns(user.id);
  }

  @Get("overview")
  overview(@CurrentUser() user: UserPrincipal) {
    return this.me.overview(user.id);
  }
}
