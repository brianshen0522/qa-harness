import type { PrismaService } from "../prisma/prisma.service";

export type LockHolder = "execute" | "explore" | "generate" | null;

/** Atomically take the target's single busy lock (idle -> running). One lock covers
 *  QA runs, exploration and generation, so the three are mutually exclusive and the
 *  test list can't change under any of them. */
export async function acquireTargetLock(prisma: PrismaService, targetId: string): Promise<boolean> {
  const r = await prisma.qaTarget.updateMany({ where: { id: targetId, status: "idle" }, data: { status: "running" } });
  return r.count === 1;
}

export async function releaseTargetLock(prisma: PrismaService, targetId: string): Promise<void> {
  await prisma.qaTarget.updateMany({ where: { id: targetId }, data: { status: "idle" } }).catch(() => undefined);
}

/** What currently holds the lock, for a precise "busy" message. */
export async function targetLockHolder(prisma: PrismaService, targetId: string): Promise<LockHolder> {
  const [run, exp, gen] = await Promise.all([
    prisma.testRun.findFirst({ where: { targetId, status: { in: ["running", "paused", "queued"] } }, select: { id: true } }),
    prisma.explorationRun.findFirst({ where: { targetId, status: { in: ["running", "paused"] } }, select: { id: true } }),
    prisma.generationRun.findFirst({ where: { targetId, status: { in: ["running", "paused"] } }, select: { id: true } }),
  ]);
  return run ? "execute" : exp ? "explore" : gen ? "generate" : null;
}

export function busyMessage(holder: LockHolder): string {
  switch (holder) {
    case "execute": return "這個 Target 正在執行 QA";
    case "explore": return "這個 Target 正在探索";
    case "generate": return "這個 Target 正在生成測試清單";
    default: return "這個 Target 忙碌中";
  }
}
