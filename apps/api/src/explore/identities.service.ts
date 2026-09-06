import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { TargetsService } from "../targets/targets.service";
import { AuditService } from "../audit/audit.service";
import type { LoginConfig } from "./crawler";

export interface IdentityInput {
  name: string;
  role?: string;
  credentialKeys?: string[];
  loginConfig?: LoginConfig;
  isAnonymous?: boolean;
}

/**
 * Named identities — a role plus the credentials that log it in. The explorer
 * crawls once per identity, which is what turns "who can see what" from a guess
 * into a comparison (see permission-matrix.ts).
 */


@Injectable()
export class IdentitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly targets: TargetsService,
    private readonly audit: AuditService,
  ) {}

  async list(targetId: string, userId: string) {
    await this.perms.requireTarget(targetId, userId, Role.viewer);
    const [identities, credentials] = await Promise.all([
      this.prisma.targetIdentity.findMany({ where: { targetId }, orderBy: { order: "asc" } }),
      this.targets.credentialMeta(targetId),
    ]);
    // Identities reference the expanded {{...}} keys (name, name.username, name.password).
    return { identities, credentialKeys: credentials.flatMap((c) => c.refs), credentials };
  }

  async create(targetId: string, userId: string, input: IdentityInput) {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    if (!input.name?.trim()) throw new BadRequestException("身份名稱不能是空的");
    await this.assertCredentials(targetId, input);

    const order = ((await this.prisma.targetIdentity.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1) + 1;
    try {
      const row = await this.prisma.targetIdentity.create({
        data: {
          targetId,
          name: input.name.trim(),
          role: (input.role ?? "user").trim(),
          credentialKeys: input.credentialKeys ?? [],
          loginConfig: (input.loginConfig ?? {}) as Prisma.InputJsonValue,
          isAnonymous: !!input.isAnonymous,
          order,
        },
      });
      await this.audit.log("user", userId, "identity.create", row.id, { targetId, name: row.name });
      return row;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new BadRequestException("已經有同名的身份");
      }
      throw err;
    }
  }

  async update(identityId: string, userId: string, input: Partial<IdentityInput>) {
    const existing = await this.load(identityId);
    await this.perms.requireTarget(existing.targetId, userId, Role.editor);
    if (input.credentialKeys) await this.assertCredentials(existing.targetId, input as IdentityInput);
    return this.prisma.targetIdentity.update({
      where: { id: identityId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.role !== undefined ? { role: input.role.trim() } : {}),
        ...(input.credentialKeys !== undefined ? { credentialKeys: input.credentialKeys } : {}),
        ...(input.loginConfig !== undefined ? { loginConfig: input.loginConfig as Prisma.InputJsonValue } : {}),
        ...(input.isAnonymous !== undefined ? { isAnonymous: input.isAnonymous } : {}),
      },
    });
  }

  async remove(identityId: string, userId: string) {
    const existing = await this.load(identityId);
    await this.perms.requireTarget(existing.targetId, userId, Role.editor);
    await this.prisma.targetIdentity.delete({ where: { id: identityId } });
    return { ok: true };
  }

  /** Internal: identities with their credentials decrypted, for the crawler. */
  async resolved(targetId: string) {
    const [identities, creds] = await Promise.all([
      this.prisma.targetIdentity.findMany({ where: { targetId }, orderBy: { order: "asc" } }),
      this.targets.decryptedCredentials(targetId),
    ]);
    return identities.map((i) => ({
      id: i.id,
      name: i.name,
      role: i.role,
      isAnonymous: i.isAnonymous,
      credentials: Object.fromEntries(i.credentialKeys.map((k) => [k, creds[k]]).filter(([, v]) => v !== undefined)) as Record<string, string>,
      login: (i.loginConfig ?? {}) as LoginConfig,
    }));
  }

  private async assertCredentials(targetId: string, input: IdentityInput) {
    if (input.isAnonymous || !input.credentialKeys?.length) return;
    // Credentials are referenced by their expanded {{...}} keys now.
    const meta = await this.targets.credentialMeta(targetId);
    const known = new Set(meta.flatMap((c) => c.refs));
    const missing = input.credentialKeys.filter((k) => !known.has(k));
    if (missing.length) throw new BadRequestException(`這些憑證不存在：${missing.join("、")}`);
  }

  private async load(identityId: string) {
    const row = await this.prisma.targetIdentity.findUnique({ where: { id: identityId } });
    if (!row) throw new NotFoundException("身份不存在");
    return row;
  }
}
