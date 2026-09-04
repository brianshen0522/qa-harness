import { SandboxAgentService, type AgentEvent } from "./sandbox-agent.service";
import { LlmExhaustedError } from "../llm/llm-gateway.service";
import type { ExecutionStep } from "@qa-harness/schemas";

const SETTINGS = { maxStepsPerCase: 20, stepTimeoutSec: 60, resolution: "1280x800" };

function step(partial: Partial<ExecutionStep> & { action: ExecutionStep["action"] }): ExecutionStep {
  return {
    schema_version: "1.0",
    phase: "executing",
    intent: "do the thing",
    observation: "saw the screen",
    ...partial,
  } as ExecutionStep;
}

function build(steps: ExecutionStep[], opts: { screenshotOk?: boolean; actionOk?: boolean } = {}) {
  const performed: { action: string; params: Record<string, unknown> }[] = [];
  const prompts: { system?: string; messages: unknown[] }[] = [];
  let i = 0;

  const sandbox = {
    settings: jest.fn().mockResolvedValue(SETTINGS),
    requireAgentPort: jest.fn().mockResolvedValue({
      port: 8000,
      instance: { name: "sbx-1", resolution: "1280x800" },
    }),
  };
  const computer = {
    screenshot: jest.fn().mockImplementation(async () =>
      opts.screenshotOk === false
        ? { ok: false, action: "screenshot", durationMs: 1, error: "scrot failed", detail: {} }
        : { ok: true, action: "screenshot", durationMs: 5, image: "AAAA", detail: {} },
    ),
    perform: jest.fn().mockImplementation(async (_port: number, action: string, params: Record<string, unknown>) => {
      performed.push({ action, params });
      return opts.actionOk === false
        ? { ok: false, action, durationMs: 3, error: "element not found", detail: {} }
        : { ok: true, action, durationMs: 3, detail: { x: 10 } };
    }),
  };
  const gateway = {
    structured: jest.fn().mockImplementation(async (_p: string, _s: string, req: { system?: string; messages: unknown[] }) => {
      prompts.push({ system: req.system, messages: req.messages });
      const next = steps[Math.min(i, steps.length - 1)];
      i++;
      return { data: next, model: "vision-model", configId: "c", configName: "cfg", attempts: [], fallbacks: 0, raw: "" };
    }),
  };

  const service = new SandboxAgentService(sandbox as never, computer as never, gateway as never);
  return { service, performed, prompts, computer, gateway, sandbox };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("SandboxAgentService.run", () => {
  it("performs actions until the model says done", async () => {
    const { service, performed } = build([
      step({ action: { type: "navigate", params: { url: "https://example.com" } } }),
      step({ action: { type: "click", params: { x: 100, y: 200 } } }),
      step({ phase: "judging", action: { type: "done", params: { summary: "找到了" } } }),
    ]);
    const events = await collect(service.run("sbx", { instruction: "去 example.com" }));

    expect(events[0]).toMatchObject({ type: "started", sandbox: "sbx-1", screen: "1280x800" });
    expect(events.filter((e) => e.type === "step")).toHaveLength(3);
    expect(performed.map((p) => p.action)).toEqual(["navigate", "click"]); // "done" is not sent to the container
    expect(events.at(-1)).toMatchObject({ type: "finished", reason: "done", steps: 3, summary: "找到了" });
  });

  it("stops at maxSteps when the model never finishes", async () => {
    const { service, performed } = build([step({ action: { type: "screenshot", params: {} } })]);
    const events = await collect(service.run("sbx", { instruction: "loop", maxSteps: 4 }));
    expect(performed).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: "finished", reason: "max_steps", steps: 4 });
  });

  it("defaults maxSteps to the configured per-case limit", async () => {
    const { service, gateway } = build([step({ action: { type: "done", params: {} } })]);
    await collect(service.run("sbx", { instruction: "x" }));
    expect(gateway.structured).toHaveBeenCalledTimes(1);
  });

  it("feeds the action result back to the model and keeps the latest screenshot", async () => {
    const { service, prompts } = build([
      step({ action: { type: "click", params: { x: 1, y: 2 } } }),
      step({ action: { type: "done", params: {} } }),
    ]);
    await collect(service.run("sbx", { instruction: "x" }));

    // First call: only the current screenshot.
    const first = prompts[0].messages as { role: string; content: unknown }[];
    expect(first).toHaveLength(1);
    expect(first[0].content).toEqual([
      { type: "image", mediaType: "image/png", base64: "AAAA" },
      { type: "text", text: expect.stringContaining("第 1 / 20 步") },
    ]);

    // Second call: the previous decision, its outcome, then the new screenshot.
    const second = prompts[1].messages as { role: string; content: unknown }[];
    expect(second).toHaveLength(3);
    expect(second[0].role).toBe("assistant");
    expect(String(second[0].content)).toContain('"type":"click"');
    expect(JSON.stringify(second[1].content)).toContain("動作 click 執行成功");
    expect(prompts[0].system).toContain("1280x800");
  });

  it("reports a failed action to the model instead of aborting", async () => {
    const { service, prompts } = build(
      [step({ action: { type: "click", params: { x: 1, y: 2 } } }), step({ action: { type: "done", params: {} } })],
      { actionOk: false },
    );
    const events = await collect(service.run("sbx", { instruction: "x" }));
    const first = events.find((e) => e.type === "step") as Extract<AgentEvent, { type: "step" }>;
    expect(first.result).toMatchObject({ ok: false, error: "element not found" });
    expect(JSON.stringify(prompts[1].messages)).toContain("動作 click 失敗：element not found");
    expect(events.at(-1)).toMatchObject({ type: "finished", reason: "done" });
  });

  it("handles `wait` without calling the container, in ms or seconds", async () => {
    const { service, performed } = build([
      step({ action: { type: "wait", params: { ms: 150 } } }),
      step({ action: { type: "wait", params: { seconds: 2 } } }),
      step({ action: { type: "wait", params: {} } }),
      step({ action: { type: "done", params: {} } }),
    ]);
    const events = await collect(service.run("sbx", { instruction: "x" }));
    expect(performed).toEqual([]);
    const waits = events.filter((e) => e.type === "step") as Extract<AgentEvent, { type: "step" }>[];
    expect(waits.slice(0, 3).map((w) => w.result.detail?.waited_ms)).toEqual([150, 2000, 1000]);
  });

  it("clamps an absurd wait instead of hanging the run", async () => {
    const { service } = build([
      step({ action: { type: "wait", params: { seconds: 900 } } }),
      step({ action: { type: "done", params: {} } }),
    ]);
    const events = await collect(service.run("sbx", { instruction: "x" }));
    const waited = events.find((e) => e.type === "step") as Extract<AgentEvent, { type: "step" }>;
    expect(waited.result.detail?.waited_ms).toBe(30_000);
  }, 40_000);

  it("rejects actions the sandbox cannot handle", async () => {
    const { service } = build([
      step({ action: { type: "http_request", params: { url: "https://x" } } }),
      step({ action: { type: "done", params: {} } }),
    ]);
    const events = await collect(service.run("sbx", { instruction: "x" }));
    const bad = events.find((e) => e.type === "step") as Extract<AgentEvent, { type: "step" }>;
    expect(bad.result.ok).toBe(false);
    expect(bad.result.error).toContain("http_request");
  });

  it("errors out when the screen cannot be captured", async () => {
    const { service } = build([step({ action: { type: "done", params: {} } })], { screenshotOk: false });
    const events = await collect(service.run("sbx", { instruction: "x" }));
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("截圖失敗") });
  });

  it("surfaces an exhausted LLM chain with its attempt log", async () => {
    const { service, gateway } = build([step({ action: { type: "done", params: {} } })]);
    gateway.structured.mockRejectedValueOnce(
      new LlmExhaustedError("no vision model", [
        { configId: "a", configName: "Local", model: "m", attempt: 0, outcome: "provider_error", durationMs: 1 },
      ]),
    );
    const events = await collect(service.run("sbx", { instruction: "x" }));
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("Local:provider_error") });
  });

  it("stops when the caller aborts", async () => {
    const { service } = build([step({ action: { type: "click", params: { x: 1, y: 1 } } })]);
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const e of service.run("sbx", { instruction: "x", maxSteps: 10, signal: controller.signal })) {
      events.push(e);
      if (e.type === "step") controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "finished", reason: "aborted" });
  });

  it("reports a clear error when the sandbox is not usable", async () => {
    const { service, sandbox } = build([step({ action: { type: "done", params: {} } })]);
    sandbox.requireAgentPort.mockRejectedValueOnce(new Error("Sandbox 沒有在執行"));
    const events = await collect(service.run("sbx", { instruction: "x" }));
    expect(events).toEqual([{ type: "error", message: "Sandbox 沒有在執行" }]);
  });
});
