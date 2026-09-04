import type { Role } from "@prisma/client";

export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function maxRole(a: Role | null | undefined, b: Role | null | undefined): Role | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export function atLeast(role: Role | null | undefined, required: Role): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[required];
}

/**
 * Effective role on a target = max(project_role, target_override).
 * Non-members of the project have no access regardless of overrides (rule 4).
 */
export function effectiveTargetRole(projectRole: Role | null, override: Role | null): Role | null {
  if (!projectRole) return null;
  return maxRole(projectRole, override);
}

/**
 * Whether a target override may be set (rules 2–4):
 * - member must be a project member
 * - override cannot be lower than the project role
 * - project owners cannot be overridden (they are always owner)
 */
export function validateOverride(projectRole: Role | null, override: Role): { ok: true } | { ok: false; reason: string } {
  if (!projectRole) return { ok: false, reason: "User is not a member of this project" };
  if (projectRole === "owner") return { ok: false, reason: "Project owners are always target owners and cannot be overridden" };
  if (ROLE_RANK[override] < ROLE_RANK[projectRole]) {
    return { ok: false, reason: `Target role cannot be lower than project role (${projectRole})` };
  }
  return { ok: true };
}
