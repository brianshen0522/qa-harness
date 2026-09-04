import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EvidenceService } from "./evidence.service";

const SWEEP_INTERVAL_MS = Number(process.env.RETENTION_SWEEP_MS ?? 6 * 60 * 60 * 1000);

/**
 * Spec §5.1: evidence is cleaned up after `sandbox_settings.retention_days`.
 * Screenshots dominate the storage bill, so they go first; the run, its steps
 * and its verdicts stay, because the history of what was tested is the point.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly evidence: EvidenceService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns how many runs had their evidence removed. */
  async sweep(): Promise<{ runs: number; objects: number }> {
    if (this.sweeping) return { runs: 0, objects: 0 };
    this.sweeping = true;
    try {
      const settings = await this.prisma.sandboxSettings.upsert({ where: { id: 1 }, create: {}, update: {} });
      const cutoff = new Date(Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000);

      const expired = await this.prisma.testRun.findMany({
        where: { endedAt: { lt: cutoff }, evidencePurgedAt: null },
        select: { id: true },
        take: 50,
      });

      let objects = 0;
      for (const run of expired) {
        objects += await this.evidence.deleteRun(run.id);
        await this.prisma.$transaction([
          // The transcript stays; only the bulky artefacts go.
          this.prisma.runStep.updateMany({ where: { runId: run.id }, data: { screenshotKey: null } }),
          this.prisma.testRun.update({ where: { id: run.id }, data: { evidencePurgedAt: new Date() } }),
        ]);
      }
      if (expired.length) {
        this.log.log(`retention: cleared evidence for ${expired.length} run(s), ${objects} object(s)`);
      }
      return { runs: expired.length, objects };
    } catch (err) {
      this.log.error(`retention sweep failed: ${(err as Error).message}`);
      return { runs: 0, objects: 0 };
    } finally {
      this.sweeping = false;
    }
  }
}
