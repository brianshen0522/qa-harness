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

function makeGateway(chain: ResolvedLlmConfig[]) {
  const prisma = { llmCallLog: { create: jest.fn().mockResolvedValue({}) } };
  const configs = { resolveChain: jest.fn().mockResolvedValue(chain), resolveOne: jest.fn() };
  const gw = new LlmGatewayService(prisma as any, configs as any);
  return { gw, prisma, configs };
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

  it("throws LlmExhaustedError with the attempt log when everything fails", async () => {
    const { gw } = makeGateway([cfg("a", "openai")]);
    gw.setProviders({ openai: fakeAdapter(() => "{}") });
    await expect(
      gw.structured("generate", "finding", { messages: [{ role: "user", content: "x" }] }, { maxRetries: 1 }),
    ).rejects.toBeInstanceOf(LlmExhaustedError);
  });

  it("execute purpose only uses vision-capable configs", async () => {
    const { gw } = makeGateway([cfg("text-only", "openai", false), cfg("vision", "anthropic", true)]);
    const t = fakeAdapter(() => validVerdict);
    const v = fakeAdapter(() => validVerdict);
    gw.setProviders({ openai: t, anthropic: v });
    const r = await gw.structured("execute", "case_verdict", { messages: [{ role: "user", content: "x" }] });
    expect(t.calls).toHaveLength(0);
    expect(r.configId).toBe("vision");
  });

  it("errors clearly when no config exists for the purpose", async () => {
    const { gw } = makeGateway([]);
    await expect(gw.structured("discuss", "finding", { messages: [] })).rejects.toThrow(/No enabled LLM config/);
  });
});
