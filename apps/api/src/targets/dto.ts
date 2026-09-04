import { IsEnum, IsObject, IsOptional, IsString, MinLength } from "class-validator";
import { DescriptionSource, Role, TargetKind } from "@prisma/client";

export class CreateTargetDto {
  @IsString() @MinLength(1) name!: string;
  @IsEnum(TargetKind) kind!: TargetKind;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsString() description?: string;
}

export class UpdateTargetDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
}

export class UpdateTargetDescriptionDto {
  @IsString() content!: string;
  @IsOptional() @IsEnum(DescriptionSource) source?: DescriptionSource;
}

export class SetTargetMemberDto {
  @IsEnum(Role) role!: Role;
}

export class SetCredentialDto {
  @IsString() @MinLength(1) key!: string;
  @IsString() value!: string;
}
