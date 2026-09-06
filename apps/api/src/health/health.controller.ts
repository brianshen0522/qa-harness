import { Controller, Get, Header, HttpCode, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Liveness, readiness and metrics. Unauthenticated on purpose: an orchestrator
 * probing the container has no session, and none of this exposes tenant data —
 * only whether the process is up and coarse operational counters.
 */
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up. Never touches a dependency. */
  @Get("health")
  live() {
    return { status: "ok", uptimeSec: Math.round(process.uptime()) };
  }

  /** Readiness: can we actually serve? Fails closed when the database is gone. */
  @Get("health/ready")
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: "ready", database: "up" };
    } catch (err) {
      throw new ServiceUnavailableException({ status: "not_ready", database: "down", error: (err as Error).message });
    }
  }

  /**
   * Prometheus text exposition. Deliberately a handful of numbers an operator
   * would page on, computed on demand — not a full instrumentation layer.
   */
  @Get("metrics")
  @Header("content-type", "text/plain; version=0.0.4")
  @HttpCode(200)
  async metrics(): Promise<string> {
    const [runsByStatus, targetsRunning, casesQueued, llmDown] = await Promise.all([
      this.prisma.testRun.groupBy({ by: ["status"], _count: { _all: true } }).catch(() => []),
      this.prisma.qaTarget.count({ where: { status: "running" } }).catch(() => 0),
      this.prisma.runCaseQueue.count({ where: { status: "queued" } }).catch(() => 0),
      this.prisma.llmConfig.count({ where: { health: "down", enabled: true } }).catch(() => 0),
    ]);

    const lines = [
      "# HELP qa_harness_up Process is serving.",
      "# TYPE qa_harness_up gauge",
      "qa_harness_up 1",
      "# HELP qa_harness_uptime_seconds Seconds since process start.",
      "# TYPE qa_harness_uptime_seconds gauge",
      `qa_harness_uptime_seconds ${Math.round(process.uptime())}`,
      "# HELP qa_harness_runs_total Test runs by status.",
      "# TYPE qa_harness_runs_total gauge",
      ...runsByStatus.map((r) => `qa_harness_runs_total{status="${r.status}"} ${r._count._all}`),
      "# HELP qa_harness_targets_running Targets currently holding the run lock.",
      "# TYPE qa_harness_targets_running gauge",
      `qa_harness_targets_running ${targetsRunning}`,
      "# HELP qa_harness_cases_queued Cases waiting to be executed.",
      "# TYPE qa_harness_cases_queued gauge",
      `qa_harness_cases_queued ${casesQueued}`,
      "# HELP qa_harness_llm_configs_down Enabled LLM configs the breaker has taken out.",
      "# TYPE qa_harness_llm_configs_down gauge",
      `qa_harness_llm_configs_down ${llmDown}`,
    ];
    return `${lines.join("\n")}\n`;
  }
}
