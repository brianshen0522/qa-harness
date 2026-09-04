import { Module } from "@nestjs/common";
import { AdminUsersController } from "./admin-users.controller";
import { AdminSystemController } from "./admin-system.controller";

@Module({ controllers: [AdminUsersController, AdminSystemController] })
export class AdminModule {}
