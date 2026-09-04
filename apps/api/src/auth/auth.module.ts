import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AuthController } from "./auth.controller";
import { AdminAuthController } from "./admin-auth.controller";
import { AuthService } from "./auth.service";
import { UserJwtStrategy } from "./strategies/user-jwt.strategy";
import { AdminJwtStrategy } from "./strategies/admin-jwt.strategy";
import { GoogleStrategy } from "./strategies/google.strategy";
import { GithubStrategy } from "./strategies/github.strategy";
import { env } from "../config/env";

const oauthStrategies = [
  ...(env.GOOGLE_CLIENT_ID ? [GoogleStrategy] : []),
  ...(env.GITHUB_CLIENT_ID ? [GithubStrategy] : []),
];

@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController, AdminAuthController],
  providers: [AuthService, UserJwtStrategy, AdminJwtStrategy, ...oauthStrategies],
  exports: [AuthService],
})
export class AuthModule {}
