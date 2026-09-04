import { SandboxAgentService, buildMessages, clamp, waitMs, type AgentTurn } from "./sandbox-agent.service";
import type { ExecutionStep } from "@qa-harness/schemas";

function turn(assistant: string, text: string, fromUser = false): AgentTurn {
  return { assistant, user: [{ type: "text", text }], fromUser };
}

function service(performResult: Record<string, unknown> = { ok: true, action: "click", durationMs: 2, detail: {} }) {
  const computer = {
    screenshot: jest.fn(),
    perform: jest.fn().mockResolvedValue(performResult),
  };
  const gateway = { structured: jest.fn() };
  return { svc: new SandboxAgentService(computer as never, gateway as never), computer, gateway };
}

const step = (action: ExecutionStep["action"]): ExecutionStep =>
  ({ schema_version: "1.0", phase: "executing", intent: "i", observation: "o", action }) as ExecutionStep;

describe("buildMessages", () => {
  it("sends only the current screenshot on the first turn", () => {
    const messages = buildMessages([], "IMG", 1, 20);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([
      { type: "image", mediaType: "image/png", base64: "IMG" },
      { type: "text", text: expect.stringContaining("第 1 / 20 步") },
    ]);
  });

  it("keeps images only for the three most recent turns", () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({
      assistant: `a${i}`,
      user: [
        { type: "image" as const, mediaType: "image/png" as const, base64: `IMG${i}` },
        { type: "text" as const, text: `result ${i}` },
      ],
    }));
    const messages = buildMessages(turns, "LATEST", 7, 20);
    const withImages = messages.filter((m) =>
      Array.isArray(m.content) && m.content.some((p) => p.type === "image"),
    );
    // Three recent turns plus the current screenshot.
    expect(withImages).toHaveLength(4);
    expect(JSON.stringify(messages)).toContain("result 0"); // older text survives
    expect(JSON.stringify(messages)).not.toContain("IMG0"); // its image does not
  });

  it("omits the assistant slot for a turn the human typed", () => {
    const messages = buildMessages([turn("", "使用者插話：停一下", true)], "IMG", 2, 20);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(messages[0].role).toBe("user");
  });
});

describe("performAction", () => {
  it("waits host-side without touching the container", async () => {
    const { svc, computer } = service();
    const r = await svc.performAction(8000, step({ type: "wait", params: { ms: 120 } }), 5000);
    expect(computer.perform).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, detail: { waited_ms: 120 } });
  });

  it("refuses actions the sandbox cannot carry out", async () => {
    const { svc, computer } = service();
    const r = await svc.performAction(8000, step({ type: "http_request", params: {} }), 5000);
    expect(computer.perform).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("http_request");
  });

  it("passes container actions through with their params", async () => {
    const { svc, computer } = service();
    await svc.performAction(8000, step({ type: "click", params: { x: 5, y: 6 } }), 5000);
    expect(computer.perform).toHaveBeenCalledWith(8000, "click", { x: 5, y: 6 }, 5000);
  });
});

describe("describeResult", () => {
  it("reports success with the detail and failure with the reason", () => {
    const { svc } = service();
    const s = step({ type: "click", params: {} });
    expect(svc.describeResult(s, { ok: true, durationMs: 1, detail: { x: 3 } })).toContain("執行成功");
    expect(svc.describeResult(s, { ok: true, durationMs: 1, detail: { x: 3 } })).toContain('{"x":3}');
    expect(svc.describeResult(s, { ok: false, durationMs: 1, error: "沒找到" })).toContain("失敗：沒找到");
  });
});

describe("helpers", () => {
  it("waitMs accepts ms, seconds or nothing", () => {
    expect(waitMs({ ms: 250 })).toBe(250);
    expect(waitMs({ seconds: 3 })).toBe(3000);
    expect(waitMs({})).toBe(1000);
    expect(waitMs(undefined)).toBe(1000);
  });

  it("clamp bounds values and rejects NaN", () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(0, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
    expect(clamp(Number.NaN, 1, 10)).toBe(1);
  });
});

describe("buildSystemPrompt", () => {
  it("states the screen size and the interjection rule", () => {
    const { svc } = service();
    const p = svc.buildSystemPrompt(1920, 1080);
    expect(p).toContain("1920x1080");
    expect(p).toContain("使用者插話");
    expect(p).toContain("done");
  });
});
