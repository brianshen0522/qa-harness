import { SandboxSessionService, type SessionEvent } from "./sandbox-session.service";
import { SandboxAgentService } from "./sandbox-agent.service";
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

const DONE = step({ phase: "judging", action: { type: "done", params: { summary: "完成了" } } });
const CLICK = step({ action: { type: "click", params: { x: 10, y: 20 } } });

/** `stepDelayMs` keeps a round in flight long enough for the test to interject. */
function build(script: ExecutionStep[] | ((call: number) => ExecutionStep), stepDelayMs = 0) {
  const performed: string[] = [];
  const seenTurns: unknown[][] = [];
  let call = 0;

  const sandbox = {
    settings: jest.fn().mockResolvedValue(SETTINGS),
    get: jest.fn().mockResolvedValue({ name: "sbx-1", resolution: "1280x800" }),
    requireAgentPort: jest.fn().mockResolvedValue({
      port: 8000,
      instance: { name: "sbx-1", resolution: "1280x800" },
    }),
  };
  const computer = {
    screenshot: jest.fn().mockResolvedValue({ ok: true, action: "screenshot", durationMs: 1, image: "IMG", detail: {} }),
    perform: jest.fn().mockImplementation(async (_p: number, action: string) => {
      performed.push(action);
      return { ok: true, action, durationMs: 2, detail: {} };
    }),
  };
  const gateway = {
    structured: jest.fn().mockImplementation(async (_purpose: string, _schema: string, req: { messages: unknown[] }) => {
      seenTurns.push(req.messages);
      const next = typeof script === "function" ? script(call) : script[Math.min(call, script.length - 1)];
      call++;
      if (stepDelayMs) await new Promise((r) => setTimeout(r, stepDelayMs));
      return { data: next, model: "vision-model", configId: "c", configName: "cfg", attempts: [], fallbacks: 0, raw: "" };
    }),
  };

  const agent = new SandboxAgentService(computer as never, gateway as never);
  const health = {
    hasUsable: jest.fn().mockResolvedValue(true),
    waitForPurpose: jest.fn().mockResolvedValue(true),
    onHealthChange: jest.fn().mockReturnValue(() => undefined),
  };
  const service = new SandboxSessionService(sandbox as never, agent, health as never);
  const events: SessionEvent[] = [];
  service.subscribe("sbx", (e) => events.push(e));
  return { service, events, performed, seenTurns, gateway, computer, sandbox, health };
}

/**
 * Wait until the queue is drained and the loop has gone idle. Reads the session
 * snapshot rather than the event log, because the log starts with the status
 * echo every subscriber receives.
 */
async function settle(service: SandboxSessionService, events: SessionEvent[], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = service.snapshot("sbx");
    if (s.status === "idle" && s.pending === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`session did not settle. events: ${events.map((e) => e.type).join(",")}`);
}

const types = (events: SessionEvent[]) => events.map((e) => e.type);

describe("SandboxSessionService", () => {
  it("runs a round from a message and goes idle when the model is done", async () => {
    const { service, events, performed } = build([CLICK, DONE]);
    await service.send("sbx", "去點那個按鈕");
    await settle(service, events);

    expect(types(events)).toEqual([
      "status", "user_message", "status", "run_started", "thinking", "step",
      "thinking", "step", "finished", "status",
    ]);
    expect(performed).toEqual(["click"]);
    const finished = events.find((e) => e.type === "finished") as Extract<SessionEvent, { type: "finished" }>;
    expect(finished).toMatchObject({ reason: "done", summary: "完成了" });
    expect(service.snapshot("sbx").status).toBe("idle");
  });

  it("continues the same conversation on the next message", async () => {
    const { service, events, seenTurns } = build([DONE]);
    await service.send("sbx", "第一件事");
    await settle(service, events);

    await service.send("sbx", "第二件事");
    await settle(service, events);

    // The second round still sees the first exchange.
    const secondPrompt = JSON.stringify(seenTurns[1]);
    expect(secondPrompt).toContain("第一件事");
    expect(secondPrompt).toContain("第二件事");
    expect(events.filter((e) => e.type === "run_started")).toHaveLength(2);
  });

  it("injects a mid-round message before the next step and marks it interjected", async () => {
    // Never finishes on its own, and each step is slow enough to interrupt.
    const { service, events, seenTurns } = build(() => CLICK, 50);
    await service.send("sbx", "一直點", 6);

    // Interject while the first step is still in flight.
    await new Promise((r) => setTimeout(r, 20));
    const res = await service.send("sbx", "停，改點左上角");
    expect(res.interjected).toBe(true);

    await settle(service, events);
    const injected = events.find(
      (e) => e.type === "user_message" && e.content === "停，改點左上角",
    ) as Extract<SessionEvent, { type: "user_message" }>;
    expect(injected.interjected).toBe(true);

    const prompts = seenTurns.map((m) => JSON.stringify(m));
    expect(prompts.some((p) => p.includes("使用者插話：停，改點左上角"))).toBe(true);
  });

  it("a first message is not labelled as an interjection", async () => {
    const { service, events, seenTurns } = build([DONE]);
    const res = await service.send("sbx", "第一句");
    expect(res.interjected).toBe(false);
    await settle(service, events);
    expect(JSON.stringify(seenTurns[0])).not.toContain("使用者插話");
  });

  it("keeps step numbers going up across an interjection", async () => {
    const { service, events } = build((call) => (call >= 3 ? DONE : CLICK), 40);
    await service.send("sbx", "一直點", 10);
    await new Promise((r) => setTimeout(r, 20));
    await service.send("sbx", "改一下做法");
    await settle(service, events);

    const stepNumbers = events
      .filter((e) => e.type === "step")
      .map((e) => (e as Extract<SessionEvent, { type: "step" }>).step);
    expect(stepNumbers).toEqual([...stepNumbers].sort((a, b) => a - b));
    expect(new Set(stepNumbers).size).toBe(stepNumbers.length);
  });

  it("gives a fresh step budget to each new round", async () => {
    const { service, events } = build((call) => (call >= 2 ? DONE : CLICK));
    await service.send("sbx", "做事", 2);
    await settle(service, events);
    // Budget of 2 is hit, so the round ends without the model saying done.
    expect(events.find((e) => e.type === "finished")).toMatchObject({ reason: "max_steps" });
    const mark = events.length;

    await service.send("sbx", "繼續");
    await settle(service, events);
    expect(events.slice(mark).find((e) => e.type === "finished")).toMatchObject({ reason: "done" });
  });

  it("stop ends the round but keeps the transcript for the next message", async () => {
    const { service, events, seenTurns } = build(() => CLICK, 50);
    await service.send("sbx", "一直點", 50);
    await new Promise((r) => setTimeout(r, 20));

    expect(service.stop("sbx")).toEqual({ stopped: true });
    await settle(service, events);
    expect(events.find((e) => e.type === "finished")).toMatchObject({ reason: "aborted" });

    await service.send("sbx", "換個做法");
    await settle(service, events);
    expect(JSON.stringify(seenTurns.at(-1))).toContain("一直點");
  });

  it("stop on an idle session is a no-op", async () => {
    const { service } = build([DONE]);
    expect(service.stop("sbx")).toEqual({ stopped: false });
  });

  it("marks a message sent while parked as an interjection", async () => {
    const { service, gateway, health } = build([DONE]);
    health.waitForPurpose.mockReturnValueOnce(new Promise<boolean>(() => undefined));
    gateway.structured.mockRejectedValueOnce(new LlmExhaustedError("停擺", [], "all_down"));

    await service.send("sbx", "做事");
    await new Promise((r) => setTimeout(r, 30));
    expect(service.snapshot("sbx").status).toBe("paused");
    await expect(service.send("sbx", "改做另一件事")).resolves.toMatchObject({ interjected: true });
  });

  it("a round parked waiting for an LLM can still be stopped", async () => {
    const { service, events, gateway, health } = build([DONE]);
    health.waitForPurpose.mockReturnValueOnce(new Promise<boolean>(() => undefined)); // never resolves
    gateway.structured.mockRejectedValueOnce(new LlmExhaustedError("停擺", [], "all_down"));

    await service.send("sbx", "做事");
    await new Promise((r) => setTimeout(r, 30));
    expect(service.snapshot("sbx").status).toBe("paused");
    expect(service.stop("sbx")).toEqual({ stopped: true });
  });

  it("reset clears the transcript so the next round starts clean", async () => {
    const { service, events, seenTurns } = build([DONE]);
    await service.send("sbx", "舊的事情");
    await settle(service, events);

    service.reset("sbx");
    expect(service.snapshot("sbx").turns).toBe(0);

    await service.send("sbx", "全新的事情");
    await settle(service, events);
    expect(JSON.stringify(seenTurns.at(-1))).not.toContain("舊的事情");
  });

  it("replays past events to a browser that connects later", async () => {
    const { service, events } = build([DONE]);
    await service.send("sbx", "做點事");
    await settle(service, events);

    const replayed: SessionEvent[] = [];
    service.subscribe("sbx", (e) => replayed.push(e));
    // The recorded log, then the status echo every new subscriber gets.
    expect(types(replayed)).toEqual([...types(events).slice(1), "status"]);
    expect(replayed.at(-1)).toMatchObject({ type: "status", status: "idle" });
  });

  it("pauses instead of failing when every model is unusable, then resumes the same step", async () => {
    const { service, events, gateway, health } = build([DONE]);
    gateway.structured.mockRejectedValueOnce(
      new LlmExhaustedError("所有 LLM 都無法使用", [
        { configId: "a", configName: "Local", model: "m", attempt: 0, outcome: "provider_error", durationMs: 1 },
      ], "all_down"),
    );
    await service.send("sbx", "做事");
    await settle(service, events);

    const paused = events.find((e) => e.type === "paused") as Extract<SessionEvent, { type: "paused" }>;
    expect(paused).toMatchObject({ reason: "all_down" });
    expect(paused.message).toContain("自動接續");
    expect(health.waitForPurpose).toHaveBeenCalledWith("execute", true, expect.anything());
    expect(events.some((e) => e.type === "resumed")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);

    // The retaken step still runs, so the round completes normally.
    expect(events.at(-1)).toMatchObject({ type: "status", status: "idle" });
    expect(events.find((e) => e.type === "finished")).toMatchObject({ reason: "done" });
    // Step numbering does not skip the step that was interrupted.
    const steps = events.filter((e) => e.type === "step") as Extract<SessionEvent, { type: "step" }>[];
    expect(steps.map((x) => x.step)).toEqual([1]);
  });

  it("stays in the paused state for as long as no model is available", async () => {
    const { service, events, gateway, health } = build([DONE]);
    let release: (available: boolean) => void = () => undefined;
    health.waitForPurpose.mockReturnValueOnce(new Promise<boolean>((r) => { release = r; }));
    gateway.structured.mockRejectedValueOnce(new LlmExhaustedError("停擺", [], "all_down"));

    await service.send("sbx", "做事");
    await new Promise((r) => setTimeout(r, 30));
    expect(service.snapshot("sbx").status).toBe("paused");
    expect(events.filter((e) => e.type === "status").at(-1)).toMatchObject({ status: "paused" });
    expect(events.some((e) => e.type === "finished")).toBe(false);

    release(true);
    await settle(service, events);
    expect(service.snapshot("sbx").status).toBe("idle");
    expect(events.find((e) => e.type === "finished")).toMatchObject({ reason: "done" });
  });

  it("a user abort while paused ends the round without losing the transcript", async () => {
    const { service, events, gateway, health } = build([DONE]);
    health.waitForPurpose.mockResolvedValueOnce(false); // aborted while waiting
    gateway.structured.mockRejectedValueOnce(new LlmExhaustedError("停擺", [], "all_down"));

    await service.send("sbx", "做事");
    await settle(service, events);
    expect(events.find((e) => e.type === "finished")).toMatchObject({ reason: "aborted" });
    expect(service.snapshot("sbx").turns).toBeGreaterThan(0);
  });

  it("still fails the round on an error that is not about model availability", async () => {
    const { service, events, gateway } = build([DONE]);
    gateway.structured.mockRejectedValueOnce(new Error("sandbox 不見了"));
    await service.send("sbx", "做事");
    await settle(service, events);
    expect(events.find((e) => e.type === "error")).toMatchObject({ message: "sandbox 不見了" });
    expect(events.some((e) => e.type === "paused")).toBe(false);
    expect(service.snapshot("sbx").status).toBe("idle");
  });

  it("ends the round when the screen cannot be captured", async () => {
    const { service, events, computer } = build([DONE]);
    computer.screenshot.mockResolvedValueOnce({ ok: false, action: "screenshot", durationMs: 1, error: "scrot failed", detail: {} });
    await service.send("sbx", "做事");
    await settle(service, events);
    expect(events.find((e) => e.type === "error")).toMatchObject({
      message: expect.stringContaining("截圖失敗"),
    });
  });

  it("rejects an empty message and a dead sandbox", async () => {
    const { service, sandbox } = build([DONE]);
    await expect(service.send("sbx", "   ")).rejects.toThrow("訊息是空的");
    sandbox.requireAgentPort.mockRejectedValueOnce(new Error("Sandbox 沒有在執行"));
    await expect(service.send("sbx", "hi")).rejects.toThrow("Sandbox 沒有在執行");
  });

  it("discard drops the session entirely", async () => {
    const { service, events } = build([DONE]);
    await service.send("sbx", "做事");
    await settle(service, events);
    service.discard("sbx");
    expect(service.snapshot("sbx")).toMatchObject({ status: "idle", turns: 0, events: [] });
  });
});
