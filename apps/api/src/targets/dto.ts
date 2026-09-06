import { IsBoolean, IsEnum, IsObject, IsOptional, IsString, MinLength } from "class-validator";
import { CredentialType, DescriptionSource, Role, TargetKind } from "@prisma/client";

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
  // New typed shape.
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsEnum(CredentialType) type?: CredentialType;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsObject() fields?: Record<string, string>;
  @IsOptional() @IsBoolean() allowRotation?: boolean;
  // Legacy single-secret shape ({ key, value }), still accepted.
  @IsOptional() @IsString() @MinLength(1) key?: string;
  @IsOptional() @IsString() value?: string;
}

export class UpdateCredentialDto {
  @IsOptional() @IsBoolean() allowRotation?: boolean;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsEnum(CredentialType) type?: CredentialType;
  @IsOptional() @IsObject() fields?: Record<string, string>;
  @IsOptional() @IsString() @MinLength(1) newKey?: string;
  /** Legacy: overwrite a single secret's value. */
  @IsOptional() @IsString() value?: string;
}
