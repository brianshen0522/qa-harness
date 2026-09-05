import { DesktopDiscoveryService } from "./desktop-discovery.service";

/** The service orchestrates sandbox + screenshot + a vision call; all three are
 *  faked here so the wiring is verified without Docker or a live model. */
function make(overrides: {
  screenshot?: { ok: boolean; image?: string; error?: string; detail: Record<string, unknown> };
  completeText?: string;
} = {}) {
  const removed: string[] = [];
  const commands: string[] = [];
  const perform = jest.fn(async (_p: number, action: string, params: Record<string, unknown>) => {
    if (action === "run_command") commands.push(String(params.command));
    return { ok: true, action, durationMs: 1, detail: {} };
  });
  const gateway = {
    complete: jest.fn(async () => ({
      text: overrides.completeText ?? "主視窗:Chromium 瀏覽器\n可見:網址列、分頁",
      model: "stub", usage: { inputTokens: 1, outputTokens: 1 }, configId: "c", attempts: [],
    })),
  };
  const sandbox = {
    create: jest.fn(async () => ({ id: "sb1", agentPort: 8000 })),
    remove: jest.fn(async (id: string) => { removed.push(id); return { ok: true }; }),
  };
  const computer = {
    perform,
    screenshot: jest.fn(async () => overrides.screenshot ?? { ok: true, image: "iVBOR", detail: {} }),
  };
  const svc = new DesktopDiscoveryService(gateway as never, sandbox as never, computer as never);
  return { svc, gateway, removed, commands };
}

describe("DesktopDiscoveryService", () => {
  it("launches the app, screenshots, and returns a vision inventory", async () => {
    const { svc, gateway, commands, removed } = make();
    const res = await svc.discover({ launch_command: "myapp --flag" }, "user1");
    expect(res.kind).toBe("desktop");
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("桌面現況");
    expect(res.summary).toContain("Chromium");
    expect(commands.some((c) => c.includes("myapp --flag"))).toBe(true);
    const opts = (gateway.complete.mock.calls[0] as unknown[])[2] as { requireVision?: boolean };
    expect(opts.requireVision).toBe(true);
    expect(removed).toEqual(["sb1"]);
  });

  it("works with no launch command (bare desktop)", async () => {
    const { svc, commands } = make();
    const res = await svc.discover({}, "user1");
    expect(res.ok).toBe(true);
    expect(commands).toHaveLength(0);
  });

  it("reports a failure and still reclaims the sandbox when the screenshot fails", async () => {
    const { svc, removed } = make({ screenshot: { ok: false, error: "no image", detail: {} } });
    const res = await svc.discover({}, "user1");
    expect(res.ok).toBe(false);
    expect(res.note).toContain("截圖失敗");
    expect(removed).toEqual(["sb1"]);
  });

  it("does not crash the pipeline when the model returns nothing", async () => {
    const { svc } = make({ completeText: "" });
    const res = await svc.discover({}, "user1");
    expect(res.ok).toBe(false);
    expect(res.summary).toBe("");
  });
});
