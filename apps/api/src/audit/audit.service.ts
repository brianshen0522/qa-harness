import { Injectable } from "@nestjs/common";
import { ActorType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    actorType: ActorType,
    actorId: string,
    action: string,
    target?: string,
    payload?: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditLog.create({
      data: { actorType, actorId, action, target, payload },
    });
  }

  list(limit = 100) {
    return this.prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  }
}
