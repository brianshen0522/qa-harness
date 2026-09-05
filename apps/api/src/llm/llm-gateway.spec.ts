process.env.CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 1).toString("base64");
process.env.DATABASE_URL ??= "postgresql://x";
process.env.USER_JWT_SECRET ??= "u";
process.env.ADMIN_JWT_SECRET ??= "a";

import { LlmGatewayService, LlmExhaustedError } from "./llm-gateway.service";
import { LlmProviderError, type LlmProviderAdapter, type LlmRequest, type ResolvedLlmConfig } from "./providers";

const cfg = (id: string, provider: ResolvedLlmConfig["provider"], vision = true): ResolvedLlmConfig => ({
  id, name: id, provider, endpoint: null, apiKey: null, model: `${provider}-model`, supportsVision: vision,
});

function fakeAdapter(script: (req: LlmRequest, call: number) => string | Error): LlmProviderAdapter & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete(_c, req) {
      calls.push(req);
      const r = script(req, calls.length);
      if (r instanceof Error) throw r;
      return { text: r, model: "m", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: false };
    },
  };
}

const validVerdict = JSON.stringify({
  schema_version: "1.0", verdict: "pass", reasoning: "ok", evidence_refs: [], repro_steps: [], possibly_changed: false,
});

function makeGateway(chain: ResolvedLlmConfig[], usable?: string[]) {
  const prisma = { llmCallLog: { create: jest.fn().mockResolvedValue({}) } };
  const configs = { resolveChain: jest.fn().mockResolvedValue(chain), resolveOne: jest.fn() };
  const health = {
    // By default every config in the chain is usable.
    usableConfigIds: jest.fn().mockResolvedValue(usable ?? chain.map((c) => c.id)),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    recordSuccess: jest.fn().mockResolvedValue(undefined),
  };
  const gw = new LlmGatewayService(prisma as any, configs as any, health as any);
  return { gw, prisma, configs, health };
}

describe("LlmGatewayService.structured", () => {
  it("returns validated data on first try and logs the call", async () => {
    const { gw, prisma } = makeGateway([cfg("a", "anthropic")]);
    const a = fakeAdapter(() => validVerdict);
    gw.setProviders({ anthropic: a });
    const r = await gw.structured("execute", "case_verdict", { messages: [{ role: "user", content: "judge" }] });
    expect(r.data.verdict).toBe("pass");
    expect(r.fallbacks).toBe(0);
    expect(r.attempts).toHaveLength(1);
    expect(prisma.llmCallLog.create).toHaveBeenCalledTimes(1);
    // schema is attached both natively and in the system prompt
    expect(a.calls[0].jsonSchema?.name).toBe("case_verdict");
    expect(a.calls[0].system).toContain("schema_version");
  });

  it("retries with validation errors fed back, then succeeds", async () => {
    const { gw } = makeGateway([cfg("a", "openai")]);
    const a = fakeAdapter((_req, call) =>
      call === 1 ? '```json\n{"schema_version":"1.0","verdict":"fail","reasoning":"x","evidence_refs":[],"repro_steps":[],"possibly_changed":false}\n```' : validVerdict,
    );
    gw.setProviders({ openai: a });
    const r = await gw.structured("generate", "case_verdict", { messages: [{ role: "user", content: "judge" }] });
    expect(r.attempts.map((x) => x.outcome)).toEqual(["invalid_output", "ok"]);
    const retryMsgs = a.calls[1].messages;
    expect(retryMsgs).toHaveLength(3);
    expect(String(retryMsgs[2].content)).toMatch(/repro_steps/);
  });

  it("falls back to the next config after retries are exhausted", async () => {
    const { gw } = makeGateway([cfg("a", "openai"), cfg("b", "anthropic")]);
    const bad = fakeAdapter(() => "not json at all");
    const good = fakeAdapter(() => validVerdict);
    gw.setProviders({ openai: bad, anthropic: good });
    const r = await gw.structured("generate", "case_verdict", { messages: [{ role: "user", content: "x" }] }, { maxRetries: 1 });
    expect(bad.calls).toHaveLength(2);
    expect(good.calls).toHaveLength(1);
    expect(r.configId).toBe("b");
    expect(r.fallbacks).toBe(1);
  });

  it("falls back immediately on timeout / rate limit / 5xx", async () => {
    for (const kind of ["timeout", "rate_limit", "server"] as const) {
      const { gw } = makeGateway([cfg("a", "ollama"), cfg("b", "anthropic")]);
      const failing = fakeAdapter(() => new LlmProviderError(kind, kind, 500));
      const good = fakeAdapter(() => validVerdict);
      gw.setProviders({ ollama: failing, anthropic: good });
      const r = await gw.structured("discuss", "case_verdict", { messages: [{ role: "user", content: "x" }] });
      expect(failing.calls).toHaveLength(1);
      expect(r.configId).toBe("b");
      expect(r.attempts[0].errorKind).toBe(kind);
    }
  });

  it("retries an empty reply without feeding the empty turn back", async () => {
    const { gw } = makeGateway([cfg("a", "anthropic")]);
    const a = fakeAdapter((_req, call) => (call === 1 ? "" : validVerdict));
    gw.setProviders({ anthropic: a });
    const r = await gw.structured("execute", "case_verdict", { messages: [{ role: "user", content: "judge" }] });
    expect(r.attempts.map((x) => x.outcome)).toEqual(["invalid_output", "ok"]);
    // The second attempt sends the original conversation unchanged.
    expect(a.calls[1].messages).toEqual(a.calls[0].messages);
  });

  it("treats a reasoning-only reply as empty and retries it the same way", async () => {
    const { gw } = makeGateway([cfg("a", "anthropic")]);
    const a = fakeAdapter((_req, call) => (call === 1 ? "<think>hmm, what to do</think>" : validVerdict));
    gw.setProviders({ anthropic: a });
    const r = await gw.structured("execute", "case_verdict", { messages: [{ role: "user", content: "judge" }] });
    expect(r.attempts[0].error).toMatch(/reasoning block/);
    expect(a.calls[1].messages).toEqual(a.calls[0].messages);
  });

  it("forwards reasoningEffort on the first call and downgrades it to low on a budget retry", async () => {
    const { gw } = makeGateway([cfg("a", "openai")]);
    const a = fakeAdapter((_req, call) => (call === 1 ? new LlmProviderError("budget", "blank") : validVerdict));
    gw.setProviders({ openai: a });
    await gw.structured("execute", "case_verdict", { messages: [{ role: "user", content: "j" }], maxTokens: 2048, reasoningEffort: "high" });
    expect(a.calls[0].reasoningEffort).toBe("high"); // forwarded as-is first
    expect(a.calls[1].reasoningEffort).toBe("low"); // dropped so the retry leaves room for output
  });

  it("grows the budget and retries the SAME config on a budget error (no fallback, no breaker hit)", async () => {
    const { gw, health } = makeGateway([cfg("a", "openai"), cfg("b", "anthropic")]);
    const a = fakeAdapter((_req, call) => (call === 1 ? new LlmProviderError("budget", "ran out of tokens thinking") : validVerdict));
    const b = fakeAdapter(() => validVerdict);
    gw.setProviders({ openai: a, anthropic: b });
    const r = await gw.structured("execute", "case_verdict", { messages: [{ role: "user", content: "judge" }], maxTokens: 2048 });
    expect(r.data.verdict).toBe("pass");
    expect(r.fallbacks).toBe(0); // stayed on config a
    expect(a.calls).toHaveLength(2); // retried same config
    expect(b.calls).toHaveLength(0); // never fell through to b
    expect(a.calls[1].maxTokens).toBeGreaterThan(a.calls[0].maxTokens ?? 0); // budget grew
    expect(health.recordFailure).not.toHaveBeenCalled(); // budget is not the config's fault
  });

  it("treats a truncated (finish_reason=length) reply as a budget miss: grows budget, retries untouched", async () => {
    const { gw } = makeGateway([cfg("a", "openai")]);
    const calls: LlmRequest[] = [];
    let n = 0;
    const adapter = {
      calls,
      async complete(_c: ResolvedLlmConfig, req: LlmRequest) {
        calls.push(req);
        n++;
        if (n === 1) return { text: '{"schema_version":"1.0","verdict":"pa', model: "m", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: false, finishReason: "length" };
        return { text: validVerdict, model: "m", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: false, finishReason: "stop" };
      },
    } as LlmProviderAdapter & { calls: LlmRequest[] };
    gw.setProviders({ openai: adapter });
    const r = await gw.structured("execute", "case_verdict", { messages: [{ role: "user", content: "judge" }], maxTokens: 2048 });
    expect(r.data.verdict).toBe("pass");
    expect(calls).toHaveLength(2);
    expect(calls[1].maxTokens).toBeGreaterThan(2048); // grew
    expect(calls[1].messages).toHaveLength(1); // retried untouched, no correction turn appended
  });

  it("throws LlmExhaustedError with the attempt log when everything fails", async () => {
    const { gw } = makeGateway([cfg("a", "openai")]);
    gw.setProviders({ openai: fakeAdapter(() => "{}") });
    await expect(
      gw.structured("generate", "finding", { messages: [{ role: "user", content: "x" }] }, { maxRetries: 1 }),
    ).rejects.toBeInstanceOf(LlmExhaustedError);
  });

  it("uses only vision-capable configs when the caller asks for vision", async () => {
    const { gw } = makeGateway([cfg("text-only", "openai", false), cfg("vision", "anthropic", true)]);
    const t = fakeAdapter(() => validVerdict);
    const v = fakeAdapter(() => validVerdict);
    gw.setProviders({ openai: t, anthropic: v });
    const r = await gw.structured("execute", "case_verdict", { messages: [{ role: "user", content: "x" }] }, { requireVision: true });
    expect(t.calls).toHaveLength(0);
    expect(r.configId).toBe("vision");
  });

  it("does not demand vision when the request has no images", async () => {
    // An api target's run sends only text, so a text-only model is fine.
    const { gw } = makeGateway([cfg("text-only", "openai", false)]);
    gw.setProviders({ openai: fakeAdapter(() => validVerdict) });
    const r = await gw.structured("execute", "case_verdict", { messages: [{ role: "user", content: "x" }] });
    expect(r.configId).toBe("text-only");
  });

  it("says so when no config exists for the purpose at all", async () => {
    const { gw } = makeGateway([]);
    await expect(gw.structured("discuss", "finding", { messages: [] })).rejects.toMatchObject({
      reason: "not_configured",
      recoverable: true,
    });
  });

  it("distinguishes configs that exist but are all currently down", async () => {
    const { gw } = makeGateway([cfg("a", "anthropic"), cfg("b", "openai")], []);
    const err = await gw.structured("discuss", "finding", { messages: [] }).catch((e) => e);
    expect(err).toMatchObject({ reason: "all_down", recoverable: true });
    expect(err.message).toMatch(/全部無法使用/);
  });

  it("skips a config the breaker has taken out and uses the next one", async () => {
    const { gw } = makeGateway([cfg("down", "openai"), cfg("up", "anthropic")], ["up"]);
    const skipped = fakeAdapter(() => validVerdict);
    const used = fakeAdapter(() => validVerdict);
    gw.setProviders({ openai: skipped, anthropic: used });
    const r = await gw.structured("generate", "case_verdict", { messages: [{ role: "user", content: "x" }] });
    expect(skipped.calls).toHaveLength(0);
    expect(r.configId).toBe("up");
  });

  it("reports provider failures and successes to the breaker", async () => {
    const { gw, health } = makeGateway([cfg("a", "ollama"), cfg("b", "anthropic")]);
    gw.setProviders({
      ollama: fakeAdapter(() => new LlmProviderError("server", "boom", 500)),
      anthropic: fakeAdapter(() => validVerdict),
    });
    await gw.structured("generate", "case_verdict", { messages: [{ role: "user", content: "x" }] });
    expect(health.recordFailure).toHaveBeenCalledWith("a", "server", "boom");
    expect(health.recordSuccess).toHaveBeenCalledWith("b");
  });

  it("counts a config that never produced valid output as a failure", async () => {
    const { gw, health } = makeGateway([cfg("a", "openai")]);
    gw.setProviders({ openai: fakeAdapter(() => "not json") });
    await gw.structured("generate", "finding", { messages: [] }, { maxRetries: 1 }).catch(() => undefined);
    expect(health.recordFailure).toHaveBeenCalledWith("a", "unknown", expect.stringContaining("finding"));
  });
});
