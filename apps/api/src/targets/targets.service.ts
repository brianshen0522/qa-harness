import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { CredentialType, DescriptionSource, Prisma, Role, TargetKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { effectiveTargetRole } from "../permissions/roles";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { validateOverride } from "../permissions/roles";
import { CREDENTIAL_NAME_RE, fieldNames, refKey, refKeys, rotatableRefKey } from "./credentials";

/** What the model/UI sees about a credential — never a value. */
export interface CredentialMeta {
  name: string;
  type: CredentialType;
  description: string;
  allowRotation: boolean;
  /** Which fields are set (e.g. ["username","password"] or ["value"]). */
  fields: string[];
  /** The `{{...}}` references the agent may write for this credential. */
  refs: string[];
  /** The reference for the rotatable secret, if rotation is enabled. */
  rotatableRef: string | null;
}

/** One credential's create/replace input (plaintext field values). */
export interface CredentialInput {
  name: string;
  type?: CredentialType;
  description?: string;
  allowRotation?: boolean;
  /** Plaintext field values keyed by field name (username/password, or value). */
  fields: Record<string, string>;
}

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
    // The caller's project role is the base for every target here; only per-target
    // overrides differ, so fetch those in one query instead of 3 per target.
    const projectRole = await this.perms.requireProject(projectId, userId, Role.viewer);
    const targets = await this.prisma.qaTarget.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { credentials: true, members: true } } },
    });
    const overrides = await this.prisma.targetMember.findMany({
      where: { userId, targetId: { in: targets.map((t) => t.id) } },
      select: { targetId: true, role: true },
    });
    const overrideBy = new Map(overrides.map((o) => [o.targetId, o.role]));
    return targets.map((t) => ({ ...t, myRole: effectiveTargetRole(projectRole, overrideBy.get(t.id) ?? null) }));
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
        credentials: { select: { name: true, type: true, description: true, allowRotation: true, fields: true }, orderBy: { name: "asc" } },
      },
    });
    if (!target) throw new NotFoundException();
    // Never expose values — only names, types, descriptions and the references.
    const credentials: CredentialMeta[] = target.credentials.map((c) => ({
      name: c.name,
      type: c.type,
      description: c.description,
      allowRotation: c.allowRotation,
      fields: fieldNames(c.type).filter((f) => (c.fields as Record<string, unknown>)?.[f] != null),
      refs: refKeys(c.name, c.type),
      rotatableRef: c.allowRotation ? rotatableRefKey(c.name, c.type) : null,
    }));
    return {
      ...target,
      myRole: role,
      // Expanded reference keys — the identity picker and older callers use these.
      credentialKeys: credentials.flatMap((c) => c.refs),
      credentials,
    };
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

  /** Create or fully replace a credential. Accepts the new typed shape; the
   *  controller also maps the legacy {key,value} body into a single `other`. */
  async setCredential(targetId: string, userId: string, input: CredentialInput) {
    await this.perms.requireTarget(targetId, userId, Role.owner);
    await this.assertNotRunning(targetId);
    const name = input.name.trim();
    if (!CREDENTIAL_NAME_RE.test(name)) throw new BadRequestException("憑證名稱只能包含文字、數字、底線與連字號（不含點與空白）。");
    const type = input.type ?? CredentialType.other;
    const encrypted = this.encryptFields(type, input.fields, true);
    await this.prisma.targetCredential.upsert({
      where: { targetId_name: { targetId, name } },
      create: { targetId, name, type, description: input.description ?? "", allowRotation: input.allowRotation ?? false, fields: encrypted },
      update: { type, description: input.description ?? "", allowRotation: input.allowRotation ?? false, fields: encrypted },
    });
    await this.audit.log("user", userId, "target.credential.set", targetId, { name, type });
    return { name };
  }

  /**
   * Partially edit a credential: description, type, rotation flag, individual
   * field values, and/or a rename. A rename rewrites every `{{name}}` and
   * `{{name.field}}` reference in this target's setup flows and identities.
   */
  async updateCredential(
    targetId: string,
    userId: string,
    name: string,
    input: { allowRotation?: boolean; description?: string; type?: CredentialType; fields?: Record<string, string>; newKey?: string },
  ) {
    await this.perms.requireTarget(targetId, userId, Role.owner);
    await this.assertNotRunning(targetId);
    const existing = await this.prisma.targetCredential.findUnique({ where: { targetId_name: { targetId, name } } });
    if (!existing) throw new NotFoundException("Credential not found");

    const newName = input.newKey?.trim();
    const renaming = !!newName && newName !== name;
    if (renaming) {
      if (!CREDENTIAL_NAME_RE.test(newName!)) throw new BadRequestException("憑證名稱只能包含文字、數字、底線與連字號（不含點與空白）。");
      const clash = await this.prisma.targetCredential.findUnique({ where: { targetId_name: { targetId, name: newName! } } });
      if (clash) throw new ConflictException(`已經有一個叫「${newName}」的憑證了。`);
    }

    const type = input.type ?? existing.type;
    const data: Prisma.TargetCredentialUpdateInput = {};
    if (input.type !== undefined) data.type = type;
    if (input.description !== undefined) data.description = input.description;
    if (input.allowRotation !== undefined) data.allowRotation = input.allowRotation;
    if (renaming) data.name = newName!;
    if (input.fields && Object.keys(input.fields).length) {
      // Merge encrypted field updates onto whatever is stored (so you can change
      // just the password of a login without re-entering the username).
      const merged = { ...(existing.fields as Record<string, string>), ...this.encryptFields(type, input.fields, false) };
      data.fields = merged;
    }
    if (!Object.keys(data).length) return { name };

    await this.prisma.$transaction(async (tx) => {
      await tx.targetCredential.update({ where: { targetId_name: { targetId, name } }, data });
      if (renaming) await this.rewriteCredentialRefs(tx, targetId, name, newName!);
    });
    await this.audit.log("user", userId, "target.credential.update", targetId, {
      name, ...(renaming ? { renamedTo: newName } : {}),
      ...(input.allowRotation === undefined ? {} : { allowRotation: input.allowRotation }),
      ...(input.fields ? { fieldsChanged: Object.keys(input.fields) } : {}),
    });
    return { name: renaming ? newName! : name };
  }

  /** Rewrite `{{old}}` and `{{old.field}}` -> the new name wherever a rename could dangle. */
  private async rewriteCredentialRefs(tx: Prisma.TransactionClient, targetId: string, oldName: string, newName: string) {
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match {{old}} or {{old.field}} and swap only the name segment.
    const ref = new RegExp(`(\\{\\{\\s*)${esc}(\\s*(?:\\.[\\p{L}\\p{N}_-]+)?\\s*\\}\\})`, "gu");
    const swap = <T>(json: T): T => JSON.parse(JSON.stringify(json).replace(ref, `$1${newName}$2`)) as T;
    const swapKey = (k: string) => (k === oldName ? newName : k.startsWith(`${oldName}.`) ? `${newName}${k.slice(oldName.length)}` : k);

    const apiSetup = await tx.apiSetup.findUnique({ where: { targetId } });
    if (apiSetup) await tx.apiSetup.update({ where: { targetId }, data: { steps: swap(apiSetup.steps) as Prisma.InputJsonValue } });

    const featureSetups = await tx.featureSetup.findMany({ where: { feature: { targetId } } });
    for (const fs of featureSetups) {
      await tx.featureSetup.update({ where: { id: fs.id }, data: { steps: swap(fs.steps) as Prisma.InputJsonValue } });
    }

    const identities = await tx.targetIdentity.findMany({ where: { targetId } });
    for (const idn of identities) {
      // loginConfig.userKey/passKey hold a bare credential key (the crawler looks
      // it up directly), so remap those too — not just any {{ref}} inside it.
      const login = swap(idn.loginConfig) as Record<string, unknown>;
      for (const f of ["userKey", "passKey"]) if (typeof login[f] === "string") login[f] = swapKey(login[f] as string);
      await tx.targetIdentity.update({
        where: { id: idn.id },
        data: { credentialKeys: idn.credentialKeys.map(swapKey), loginConfig: login as Prisma.InputJsonValue },
      });
    }
  }

  /**
   * Owner-only: reveal a credential's current values in plaintext, for editing.
   * This is the one place a stored secret leaves the server; it is gated to the
   * target owner and audited. Never call it from list/read paths.
   */
  async revealCredential(targetId: string, userId: string, name: string): Promise<{ name: string; type: CredentialType; fields: Record<string, string> }> {
    await this.perms.requireTarget(targetId, userId, Role.owner);
    const row = await this.prisma.targetCredential.findUnique({ where: { targetId_name: { targetId, name } } });
    if (!row) throw new NotFoundException("Credential not found");
    const stored = (row.fields ?? {}) as Record<string, string>;
    const fields: Record<string, string> = {};
    for (const f of fieldNames(row.type)) if (stored[f] != null) fields[f] = this.crypto.decrypt(stored[f]);
    await this.audit.log("user", userId, "target.credential.reveal", targetId, { name });
    return { name: row.name, type: row.type, fields };
  }

  async deleteCredential(targetId: string, userId: string, name: string) {
    await this.perms.requireTarget(targetId, userId, Role.owner);
    await this.assertNotRunning(targetId);
    const existing = await this.prisma.targetCredential.findUnique({ where: { targetId_name: { targetId, name } } });
    if (!existing) throw new NotFoundException("Credential not found");
    const gone = new Set(refKeys(name, existing.type)); // {{name}} or {{name.username/password}}
    await this.prisma.$transaction(async (tx) => {
      await tx.targetCredential.delete({ where: { targetId_name: { targetId, name } } });
      // Drop the now-dangling references from any identity that logged in with it.
      const identities = await tx.targetIdentity.findMany({ where: { targetId } });
      for (const idn of identities) {
        const kept = idn.credentialKeys.filter((k) => !gone.has(k));
        if (kept.length !== idn.credentialKeys.length) await tx.targetIdentity.update({ where: { id: idn.id }, data: { credentialKeys: kept } });
      }
    });
    await this.audit.log("user", userId, "target.credential.delete", targetId, { name });
    return { ok: true };
  }

  /** Encrypt the plaintext fields for a credential type. On create, require the
   *  full set (a password needs both username and password); on a partial edit,
   *  only the provided fields are encrypted. */
  private encryptFields(type: CredentialType, fields: Record<string, string>, requireAll: boolean): Record<string, string> {
    const allowed = fieldNames(type);
    const out: Record<string, string> = {};
    for (const f of allowed) {
      const v = fields[f];
      if (v === undefined || v === null || v === "") {
        if (requireAll) throw new BadRequestException(`憑證缺少欄位「${f}」。`);
        continue;
      }
      out[f] = this.crypto.encrypt(String(v));
    }
    return out;
  }

  /** Internal: decrypt every credential and expand it to the `{{...}}` reference
   *  map the run/crawler use — `name` for a single secret, `name.username` /
   *  `name.password` for a login. Never exposed over HTTP. */
  async decryptedCredentials(targetId: string): Promise<Record<string, string>> {
    const rows = await this.prisma.targetCredential.findMany({ where: { targetId } });
    const out: Record<string, string> = {};
    for (const row of rows) {
      const stored = (row.fields ?? {}) as Record<string, string>;
      for (const f of fieldNames(row.type)) {
        const enc = stored[f];
        if (enc == null) continue;
        out[refKey(row.name, f)] = this.crypto.decrypt(enc);
      }
    }
    return out;
  }

  /** Internal: metadata (no values) the run prompt needs to describe credentials. */
  async credentialMeta(targetId: string): Promise<CredentialMeta[]> {
    const rows = await this.prisma.targetCredential.findMany({ where: { targetId }, orderBy: { name: "asc" } });
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      description: r.description,
      allowRotation: r.allowRotation,
      fields: fieldNames(r.type).filter((f) => (r.fields as Record<string, unknown>)?.[f] != null),
      refs: refKeys(r.name, r.type),
      rotatableRef: r.allowRotation ? rotatableRefKey(r.name, r.type) : null,
    }));
  }

  /** Internal: the rotatable secret's reference for each rotatable credential. */
  async rotatableCredentialKeys(targetId: string): Promise<Set<string>> {
    const rows = await this.prisma.targetCredential.findMany({ where: { targetId, allowRotation: true }, select: { name: true, type: true } });
    return new Set(rows.map((r) => rotatableRefKey(r.name, r.type)));
  }

  /**
   * Internal: sync a rotated secret to the value it now has on the target, after a
   * run changed it. `ref` is the rotatable reference (`name` or `name.password`).
   * Skips the owner check and running-lock — it is the run engine, already holding
   * the target, writing reality back. Only called for an `allowRotation` credential.
   */
  /**
   * Internal: sync a non-secret credential field (the username) after a run
   * changed it on the target. A profile-edit test can rename an account, which
   * silently invalidates the stored credential just as surely as a password
   * change — rotation only ever covered the secret half.
   */
  async setCredentialField(targetId: string, name: string, field: string, value: string, actorId: string): Promise<void> {
    if (field === "password" || field === "value") {
      throw new BadRequestException("密碼類欄位必須走輪替流程，不能直接設定。");
    }
    const row = await this.prisma.targetCredential.findUnique({ where: { targetId_name: { targetId, name } } });
    if (!row) throw new NotFoundException(`找不到憑證：${name}`);
    if (!fieldNames(row.type).includes(field)) throw new BadRequestException(`憑證「${name}」沒有欄位「${field}」。`);
    const fields = { ...(row.fields as Record<string, string>), [field]: this.crypto.encrypt(value) };
    await this.prisma.targetCredential.update({ where: { targetId_name: { targetId, name } }, data: { fields } });
    await this.audit.log("user", actorId, "target.credential.field_synced", targetId, { name, field });
  }

  async rotateCredentialValue(targetId: string, ref: string, value: string, actorId: string): Promise<void> {
    const rows = await this.prisma.targetCredential.findMany({ where: { targetId, allowRotation: true } });
    const row = rows.find((r) => rotatableRefKey(r.name, r.type) === ref);
    if (!row) throw new NotFoundException(`找不到可輪替的憑證：${ref}`);
    const field = row.type === CredentialType.password ? "password" : "value";
    const fields = { ...(row.fields as Record<string, string>), [field]: this.crypto.encrypt(value) };
    await this.prisma.targetCredential.update({ where: { targetId_name: { targetId, name: row.name } }, data: { fields } });
    await this.audit.log("user", actorId, "target.credential.rotate", targetId, { name: row.name, field });
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
