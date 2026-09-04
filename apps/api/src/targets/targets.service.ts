import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DescriptionSource, Prisma, Role, TargetKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { validateOverride } from "../permissions/roles";

/** Config keys accepted per kind (spec §3.3). Unknown keys are kept but flagged. */
export const CONFIG_KEYS: Record<TargetKind, string[]> = {
  api: ["base_url", "openapi_url", "openapi_schema", "headers"],
  web: ["url", "viewport"],
  desktop: ["install_command", "image", "launch_command"],
};

@Injectable()
export class TargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async list(projectId: string, userId: string) {
    await this.perms.requireProject(projectId, userId, Role.viewer);
    const targets = await this.prisma.qaTarget.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { credentials: true, members: true } } },
    });
    const roles = await Promise.all(targets.map((t) => this.perms.targetRole(t.id, userId)));
    return targets.map((t, i) => ({ ...t, myRole: roles[i].role }));
  }

  async create(projectId: string, userId: string, input: { name: string; kind: TargetKind; config?: Record<string, unknown>; description?: string }) {
    await this.perms.requireProject(projectId, userId, Role.owner);
    const target = await this.prisma.qaTarget.create({
      data: {
        projectId,
        name: input.name,
        kind: input.kind,
        config: (input.config ?? {}) as Prisma.InputJsonObject,
        description: input.description ?? "",
        descriptionVersion: input.description ? 1 : 0,
      },
    });
    await this.audit.log("user", userId, "target.create", target.id, { projectId, kind: input.kind });
    return target;
  }

  async get(targetId: string, userId: string) {
    const { role } = await this.perms.requireTarget(targetId, userId, Role.viewer);
    const target = await this.prisma.qaTarget.findUnique({
      where: { id: targetId },
      include: {
        project: { select: { id: true, name: true } },
        credentials: { select: { key: true } },
      },
    });
    if (!target) throw new NotFoundException();
    return { ...target, myRole: role, credentialKeys: target.credentials.map((c) => c.key), credentials: undefined };
  }

  async update(targetId: string, userId: string, input: { name?: string; config?: Record<string, unknown> }) {
    await this.perms.requireTarget(targetId, userId, Role.owner);
    await this.assertNotRunning(targetId);
    const target = await this.prisma.qaTarget.update({
      where: { id: targetId },
      data: { ...(input.name ? { name: input.name } : {}), ...(input.config ? { config: input.config as Prisma.InputJsonObject } : {}) },
    });
    await this.audit.log("user", userId, "target.update", targetId, { fields: Object.keys(input) });
    return target;
  }

  async remove(targetId: string, userId: string) {
    await this.perms.requireTarget(targetId, userId, Role.owner);
    await this.assertNotRunning(targetId);
    await this.prisma.qaTarget.delete({ where: { id: targetId } });
    await this.audit.log("user", userId, "target.delete", targetId);
    return { ok: true };
  }

  async updateDescription(targetId: string, userId: string, content: string, _source: DescriptionSource = "manual") {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    await this.assertNotRunning(targetId);
    return this.prisma.qaTarget.update({
      where: { id: targetId },
      data: { description: content, descriptionVersion: { increment: 1 } },
    });
  }

  // ----- credentials (owner only; values never returned) -----

  async setCredential(targetId: string, userId: string, key: string, value: string) {
    await this.perms.requireTarget(targetId, userId, Role.owner);
    await this.assertNotRunning(targetId);
    await this.prisma.targetCredential.upsert({
      where: { targetId_key: { targetId, key } },
      create: { targetId, key, encryptedValue: this.crypto.encrypt(value) },
      update: { encryptedValue: this.crypto.encrypt(value) },
    });
    await this.audit.log("user", userId, "target.credential.set", targetId, { key });
    return { key };
  }

  async deleteCredential(targetId: string, userId: string, key: string) {
    await this.perms.requireTarget(targetId, userId, Role.owner);
    await this.assertNotRunning(targetId);
    await this.prisma.targetCredential.delete({ where: { targetId_key: { targetId, key } } }).catch(() => {
      throw new NotFoundException("Credential not found");
    });
    await this.audit.log("user", userId, "target.credential.delete", targetId, { key });
    return { ok: true };
  }

  /** Internal: decrypt all credentials for the worker. Never exposed over HTTP. */
  async decryptedCredentials(targetId: string): Promise<Record<string, string>> {
    const rows = await this.prisma.targetCredential.findMany({ where: { targetId } });
    return Object.fromEntries(rows.map((r) => [r.key, this.crypto.decrypt(r.encryptedValue)]));
  }

  // ----- member overrides -----

  async members(targetId: string, userId: string) {
    const { projectId } = await this.perms.requireTarget(targetId, userId, Role.viewer);
    const [projectMembers, overrides] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId },
        include: { user: { select: { id: true, email: true, name: true, status: true } } },
      }),
      this.prisma.targetMember.findMany({ where: { targetId } }),
    ]);
    const overrideMap = new Map(overrides.map((o) => [o.userId, o.role]));
    return projectMembers.map((m) => {
      const override = overrideMap.get(m.userId) ?? null;
      const effective = m.role === Role.owner ? Role.owner : override && override !== m.role ? override : m.role;
      return { user: m.user, projectRole: m.role, targetRole: override, effectiveRole: effective };
    });
  }

  async setMember(targetId: string, actorId: string, userId: string, role: Role) {
    const { projectId } = await this.perms.requireTarget(targetId, actorId, Role.owner);
    const projectRole = await this.perms.projectRole(projectId, userId);
    const check = validateOverride(projectRole, role);
    if (!check.ok) throw new BadRequestException(check.reason);
    const row = await this.prisma.targetMember.upsert({
      where: { targetId_userId: { targetId, userId } },
      create: { targetId, userId, role },
      update: { role },
    });
    await this.audit.log("user", actorId, "target.member.set", targetId, { userId, role });
    return row;
  }

  async removeMember(targetId: string, actorId: string, userId: string) {
    await this.perms.requireTarget(targetId, actorId, Role.owner);
    await this.prisma.targetMember.deleteMany({ where: { targetId, userId } });
    await this.audit.log("user", actorId, "target.member.remove", targetId, { userId });
    return { ok: true };
  }

  private async assertNotRunning(targetId: string) {
    const t = await this.prisma.qaTarget.findUnique({ where: { id: targetId }, select: { status: true } });
    if (t?.status === "running") throw new ConflictException("Target is running; config, credentials and description are locked");
  }
}
