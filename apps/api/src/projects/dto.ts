import { IsEmail, IsEnum, IsOptional, IsString, IsUUID, MinLength } from "class-validator";
import { DescriptionSource, Role } from "@prisma/client";

export class CreateProjectDto {
  @IsUUID() teamId!: string;
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() description?: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
}

export class UpdateDescriptionDto {
  @IsString() content!: string;
  @IsOptional() @IsEnum(DescriptionSource) source?: DescriptionSource;
}

export class AddProjectMemberDto {
  @IsEmail() email!: string;
  @IsEnum(Role) role!: Role;
}

export class UpdateProjectMemberDto {
  @IsEnum(Role) role!: Role;
}
