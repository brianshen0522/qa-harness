process.env.CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
process.env.DATABASE_URL ??= "postgresql://x";
process.env.USER_JWT_SECRET ??= "u";
process.env.ADMIN_JWT_SECRET ??= "a";

import { LlmHealth } from "@prisma/client";
import { FAILURE_THRESHOLD, LlmHealthService } from "./llm-health.service";
import { LlmProviderError } from "./providers";

interface Row {
  id: string;
  name: string;
  provider: "anthropic" | "openai" | "ollama";
  endpoint: string | null;
  apiKeyEncrypted: string | null;
  model: string;
  supportsVision: boolean;
  enabled: boolean;
  purposes: ("discuss" | "generate" | "execute")[];
  health: LlmHealth;
  consecutiveFailures: number;
  downSince: Date | null;
  probeAttempts: number;
  nextProbeAt: Date | null;
  lastProbeAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureKind: string | null;
  lastFailureMessage: string | null;
  lastRecoveredAt: Date | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "a", name: "Cfg A", provider: "anthropic", endpoint: null, apiKeyEncrypted: null,
    model: "m", supportsVision: true, enabled: true, purposes: ["generate", "execute"],
    health: LlmHealth.healthy, consecutiveFailures: 0, downSince: null, probeAttempts: 0,
    nextProbeAt: null, lastProbeAt: null, lastFailureAt: null, lastFailureKind: null,
    lastFailureMessage: null, lastRecoveredAt: null, ...over,
  };
}

/** In-memory stand-in for the two Prisma tables the service touches. */
function makePrisma(rows: Row[]) {
  const chain = rows.flatMap((r) => r.purposes.map((purpose, order) => ({ purpose, llmConfigId: r.id, order, config: r })));
  return {
    rows,
    llmConfig: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        let out = rows;
        if (where?.enabled !== undefined) out = out.filter((r) => r.enabled === where.enabled);
        if (where?.health) out = out.filter((r) => r.health === where.health);
        if (where?.OR) {
          const now = Date.now();
          out = out.filter((r) => r.nextProbeAt === null || r.nextProbeAt.getTime() <= now);
        }
        return out;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    llmFallbackChain: {
      findMany: jest.fn(async ({ where }: { where: { purpose: string; llmConfig?: Record<string, unknown> } }) =>
        chain
          .filter((c) => c.purpose === where.purpose)
          .filter((c) => c.config.enabled)
          .filter((c) => c.config.health !== LlmHealth.down)
          .filter((c) => !(where.llmConfig as { supportsVision?: boolean })?.supportsVision || c.config.supportsVision)
          .map((c) => ({ llmConfigId: c.llmConfigId })),
      ),
      count: jest.fn(async ({ where }: { where: { purpose: string } }) =>
        chain.filter((c) => c.purpose === where.purpose && c.config.enabled).length,
      ),
    },
  };
}

function build(rows: Row[], probe?: () => void | never) {
  const prisma = makePrisma(rows);
  const crypto = { decrypt: (v: string) => v };
  const service = new LlmHealthService(prisma as never, crypto as never);
  const calls: string[] = [];
  const adapter = {
    async complete(cfg: { id: string }) {
      calls.push(cfg.id);
      probe?.();
      return { text: "ok", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: false };
    },
  };
  service.setProviders({ anthropic: adapter, openai: adapter, ollama: adapter });
  return { service, prisma, rows, probeCalls: calls };
}

describe("circuit breaker", () => {
  it("degrades on the first failure and only trips at the threshold", async () => {
    const { service, rows } = build([row()]);
    for (let i = 1; i < FAILURE_THRESHOLD; i++) {
      await service.recordFailure("a", "server", "boom");
      expect(rows[0].health).toBe(LlmHealth.degraded);
      expect(rows[0].consecutiveFailures).toBe(i);
    }
    await service.recordFailure("a", "server", "boom");
    expect(rows[0].health).toBe(LlmHealth.down);
    expect(rows[0].downSince).toBeInstanceOf(Date);
    expect(rows[0].nextProbeAt).toBeInstanceOf(Date);
  });

  it("a success clears the counter, so an occasional failure never trips it", async () => {
    const { service, rows } = build([row()]);
    for (let i = 0; i < 10; i++) {
      await service.recordFailure("a", "timeout", "slow");
      await service.recordSuccess("a");
    }
    expect(rows[0].health).toBe(LlmHealth.healthy);
    expect(rows[0].consecutiveFailures).toBe(0);
  });

  it("stays down on further failures instead of flapping back into the chain", async () => {
    const { service, rows } = build([row()]);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await service.recordFailure("a", "network", "refused");
    expect(rows[0].health).toBe(LlmHealth.down);

    // Whatever else happens, a down config must not be offered again until a
    // probe or an admin says it is back.
    for (let i = 0; i < 5; i++) {
      await service.recordFailure("a", "network", "refused");
      expect(rows[0].health).toBe(LlmHealth.down);
      expect(await service.hasUsable("generate")).toBe(false);
    }
  });

  it("records why it went down, for the admin page", async () => {
    const { service, rows } = build([row()]);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await service.recordFailure("a", "auth", "invalid api key");
    expect(rows[0]).toMatchObject({ lastFailureKind: "auth", lastFailureMessage: "invalid api key" });
  });

  it("an edit by an admin puts a config straight back into rotation", async () => {
    const { service, rows } = build([row({ health: LlmHealth.down, consecutiveFailures: 9, probeAttempts: 4 })]);
    await service.resetAfterEdit("a");
    expect(rows[0]).toMatchObject({ health: LlmHealth.healthy, consecutiveFailures: 0, probeAttempts: 0, nextProbeAt: null });
  });
});

describe("availability", () => {
  it("hides down configs from the usable chain but still counts them as configured", async () => {
    const { service } = build([row({ id: "a", health: LlmHealth.down }), row({ id: "b" })]);
    expect(await service.usableConfigIds("generate")).toEqual(["b"]);
    expect(await service.hasUsable("generate")).toBe(true);
    expect(await service.hasAnyConfigured("generate")).toBe(true);
  });

  it("reports nothing usable when every config is down", async () => {
    const { service } = build([row({ id: "a", health: LlmHealth.down }), row({ id: "b", health: LlmHealth.down })]);
    expect(await service.hasUsable("generate")).toBe(false);
    expect(await service.hasAnyConfigured("generate")).toBe(true);
  });

  it("filters on vision for the execute purpose", async () => {
    const { service } = build([row({ id: "a", supportsVision: false }), row({ id: "b", supportsVision: true })]);
    expect(await service.usableConfigIds("execute", true)).toEqual(["b"]);
  });
});

describe("waitForPurpose", () => {
  it("resolves immediately when something is already usable", async () => {
    const { service } = build([row()]);
    await expect(service.waitForPurpose("generate", false)).resolves.toBe(true);
  });

  it("waits while everything is down and resolves the moment one recovers", async () => {
    const { service, rows } = build([row({ health: LlmHealth.down })]);
    let resolved = false;
    const waiting = service.waitForPurpose("generate", false).then((v) => { resolved = v; return v; });

    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    await service.recordSuccess("a"); // the probe found it again
    await expect(waiting).resolves.toBe(true);
    expect(rows[0].health).toBe(LlmHealth.healthy);
  });

  it("also wakes when an admin fixes the config by hand", async () => {
    const { service } = build([row({ health: LlmHealth.down })]);
    const waiting = service.waitForPurpose("generate", false);
    await new Promise((r) => setTimeout(r, 20));
    await service.resetAfterEdit("a");
    await expect(waiting).resolves.toBe(true);
  });

  it("returns false when the caller aborts instead of waiting forever", async () => {
    const { service } = build([row({ health: LlmHealth.down })]);
    const controller = new AbortController();
    const waiting = service.waitForPurpose("generate", false, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBe(false);
  });
});

describe("the probe loop", () => {
  it("only probes configs that are down and due", async () => {
    const { service, probeCalls } = build([
      row({ id: "healthy" }),
      row({ id: "due", health: LlmHealth.down, nextProbeAt: new Date(Date.now() - 1000) }),
      row({ id: "not-due", health: LlmHealth.down, nextProbeAt: new Date(Date.now() + 60_000) }),
    ]);
    await service.probeOnce();
    expect(probeCalls).toEqual(["due"]);
  });

  it("puts a config back into rotation as soon as it answers", async () => {
    const { service, rows } = build([row({ health: LlmHealth.down, consecutiveFailures: 5, probeAttempts: 3 })]);
    const recovered = await service.probeOnce();
    expect(recovered).toBe(1);
    expect(rows[0]).toMatchObject({ health: LlmHealth.healthy, consecutiveFailures: 0, probeAttempts: 0 });
    expect(rows[0].lastRecoveredAt).toBeInstanceOf(Date);
  });

  it("backs off while a config stays down, and never gives up on it", async () => {
    const { service, rows } = build([row({ health: LlmHealth.down })], () => {
      throw new LlmProviderError("network", "still unreachable");
    });
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      rows[0].nextProbeAt = new Date(Date.now() - 1000); // make it due again
      const before = Date.now();
      await service.probeOnce();
      delays.push(rows[0].nextProbeAt!.getTime() - before);
      expect(rows[0].health).toBe(LlmHealth.down);
    }
    // Growing, then capped, and always scheduled for another try.
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
    expect(delays.at(-1)).toBeLessThanOrEqual(300_000);
    expect(delays.every((d) => d > 0)).toBe(true);
    expect(rows[0].probeAttempts).toBe(6);
  });

  it("a hand-run probe on a healthy config respects the failure threshold", async () => {
    const { service, rows } = build([row()], () => {
      throw new LlmProviderError("network", "refused");
    });
    for (let i = 1; i < FAILURE_THRESHOLD; i++) {
      await service.probeConfig("a");
      expect(rows[0].health).toBe(LlmHealth.degraded);
    }
    await service.probeConfig("a");
    expect(rows[0].health).toBe(LlmHealth.down);
  });

  it("a probe on an already-down config records the reason without counting again", async () => {
    const { service, rows } = build([row({ health: LlmHealth.down, consecutiveFailures: 3 })], () => {
      throw new LlmProviderError("timeout", "still slow");
    });
    await service.probeConfig("a");
    expect(rows[0]).toMatchObject({
      health: LlmHealth.down,
      consecutiveFailures: 3,
      lastFailureKind: "timeout",
      lastFailureMessage: "still slow",
    });
  });

  it("a failing config cannot stop the sweep from checking the others", async () => {
    let call = 0;
    const { service, probeCalls } = build(
      [
        row({ id: "bad", health: LlmHealth.down, nextProbeAt: new Date(0) }),
        row({ id: "good", health: LlmHealth.down, nextProbeAt: new Date(0) }),
      ],
      () => {
        call++;
        if (call === 1) throw new LlmProviderError("server", "down");
      },
    );
    const recovered = await service.probeOnce();
    expect(probeCalls).toEqual(["bad", "good"]);
    expect(recovered).toBe(1);
  });

  it("does not start a second sweep while one is running", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const prisma = makePrisma([row({ health: LlmHealth.down, nextProbeAt: new Date(0) })]);
    const service = new LlmHealthService(prisma as never, { decrypt: (v: string) => v } as never);
    const calls: string[] = [];
    service.setProviders({
      anthropic: {
        async complete(cfg: { id: string }) {
          calls.push(cfg.id);
          await gate;
          return { text: "ok", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: false };
        },
      } as never,
    });

    const first = service.probeOnce();
    const second = await service.probeOnce(); // returns straight away
    expect(second).toBe(0);
    expect(calls).toHaveLength(1);
    release();
    await first;
  });

  it("survives a database error without throwing, so the timer keeps ticking", async () => {
    const prisma = makePrisma([]);
    prisma.llmConfig.findMany = jest.fn().mockRejectedValue(new Error("db is gone"));
    const service = new LlmHealthService(prisma as never, { decrypt: (v: string) => v } as never);
    await expect(service.probeOnce()).resolves.toBe(0);
    // Still usable afterwards.
    await expect(service.probeOnce()).resolves.toBe(0);
  });
});

describe("status", () => {
  it("summarises coverage per purpose, separating configured from usable", async () => {
    const { service } = build([
      row({ id: "a", purposes: ["generate", "execute"], health: LlmHealth.down }),
      row({ id: "b", purposes: ["generate"] }),
      row({ id: "c", purposes: ["discuss"], enabled: false }),
    ]);
    const status = await service.status();
    expect(status.coverage.generate).toEqual({ configured: 2, usable: 1 });
    expect(status.coverage.execute).toEqual({ configured: 1, usable: 0 });
    expect(status.coverage.discuss).toEqual({ configured: 0, usable: 0 });
    expect(status.probeIntervalMs).toBeGreaterThan(0);
  });
});
