import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { IsEmail, IsString, MinLength } from "class-validator";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { TeamsService } from "./teams.service";

class CreateTeamDto {
  @IsString() @MinLength(1) name!: string;
}
class AddMemberDto {
  @IsEmail() email!: string;
}

@Controller("teams")
@UseGuards(UserAuthGuard)
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  list(@CurrentUser() user: UserPrincipal) {
    return this.teams.listForUser(user.id);
  }

  @Post()
  create(@CurrentUser() user: UserPrincipal, @Body() dto: CreateTeamDto) {
    return this.teams.create(user.id, dto.name);
  }

  @Get(":teamId/members")
  members(@CurrentUser() user: UserPrincipal, @Param("teamId") teamId: string) {
    return this.teams.members(teamId, user.id);
  }

  @Post(":teamId/members")
  addMember(@CurrentUser() user: UserPrincipal, @Param("teamId") teamId: string, @Body() dto: AddMemberDto) {
    return this.teams.addMember(teamId, user.id, dto.email);
  }

  @Delete(":teamId/members/:userId")
  removeMember(@CurrentUser() user: UserPrincipal, @Param("teamId") teamId: string, @Param("userId") userId: string) {
    return this.teams.removeMember(teamId, user.id, userId);
  }
}
