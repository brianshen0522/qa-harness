import { buildMessages, maskSecrets, summariseProbe, SCREENSHOT_WINDOW } from "./run-utils";
import type { ContentPart } from "../llm/providers";

const img = (n: number): ContentPart[] => [
  { type: "image", mediaType: "image/png", base64: `frame-${n}` },
  { type: "text", text: `obs-${n}` },
];

describe("buildMessages", () => {
  it("keeps images only on the last SCREENSHOT_WINDOW turns; older turns go text-only", () => {
    const turns = [0, 1, 2, 3, 4].map((n) => ({ assistant: `a-${n}`, user: img(n) }));
    const msgs = buildMessages(turns, "now", 6, 60);
    // user turns are at odd indices (assistant, user, assistant, user, ...)
    const userTurns = msgs.filter((_, i) => i % 2 === 1).slice(0, turns.length);
    const hasImage = (c: (typeof userTurns)[number]["content"]) => Array.isArray(c) && c.some((p) => p.type === "image");
    // First 2 (5 - 3) dropped their image; last 3 kept it.
    expect(userTurns.slice(0, 2).every((m) => !hasImage(m.content))).toBe(true);
    expect(userTurns.slice(2).every((m) => hasImage(m.content))).toBe(true);
    expect(SCREENSHOT_WINDOW).toBe(3);
    // The final message carries the current screenshot + step text.
    const last = msgs.at(-1)!;
    expect(Array.isArray(last.content) && last.content.some((p) => p.type === "image" && p.base64 === "now")).toBe(true);
  });

  it("uses a plain-text final message when there is no screenshot (api runs)", () => {
    const msgs = buildMessages([], null, 1, 10);
    expect(msgs).toHaveLength(1);
    expect(typeof msgs[0].content).toBe("string");
  });
});

describe("maskSecrets", () => {
  it("masks a secret even when it contains quotes / newlines (JSON-escaped form)", () => {
    const secret = 'a"b\nc';
    const out = maskSecrets({ token: secret, note: `x ${secret} y` }, [secret]);
    expect(JSON.stringify(out)).not.toContain('a\\"b');
    expect(out.token).toBe("****");
    expect(out.note).toBe("x **** y");
  });

  it("masks nested values", () => {
    const out = maskSecrets({ a: { b: ["prefix-SECRETLONGVALUE"] } }, ["SECRETLONGVALUE"]);
    expect(JSON.stringify(out)).not.toContain("SECRETLONGVALUE");
  });

  it("returns the value untouched when there are no secrets", () => {
    const v = { keep: "SECRETLONGVALUE" };
    expect(maskSecrets(v, [])).toEqual(v);
  });
});

describe("summariseProbe", () => {
  const probe = (over: Partial<Parameters<typeof summariseProbe>[0]> = {}) => ({
    url: "http://x/login", path: "/login", title: "Sign in",
    headings: Array.from({ length: 30 }, (_, i) => `h${i}`),
    links: [
      { href: "/a", text: "Browse", visible: true },
      { href: "/b", text: "hidden", visible: false },
      { href: "/c", text: "   ", visible: true },
      ...Array.from({ length: 80 }, (_, i) => ({ href: `/l${i}`, text: `link${i}`, visible: true })),
    ],
    forms: [{ action: "/login", method: "post", fields: [{ name: "login", type: "text", required: true, label: "Username" }] }],
    controls: [{ text: "Sign In", role: "button", disabled: false }, { text: "  ", role: "button", disabled: false }],
    landmarks: [], scrollWidth: 1400, clientWidth: 1280, textLength: 10, dialogs: 0, overlay: false,
    ...over,
  });

  it("keeps what the agent needs to act: path, fields, clickable text", () => {
    const s = summariseProbe(probe()) as Record<string, any>;
    expect(s.path).toBe("/login");
    expect(s.forms[0].fields[0]).toMatchObject({ name: "login", label: "Username", required: true });
    expect(s.controls).toEqual([{ text: "Sign In", role: "button", disabled: false }]); // blank dropped
  });

  it("drops invisible/blank links and caps the list so context stays bounded", () => {
    const s = summariseProbe(probe()) as Record<string, any>;
    expect(s.links.length).toBe(40);
    expect(s.links.map((l: any) => l.text)).not.toContain("hidden");
    expect(s.headings.length).toBe(12);
  });

  it("flags horizontal overflow (the RWD signal)", () => {
    expect((summariseProbe(probe()) as any).horizontalOverflow).toBe(true);
    expect((summariseProbe(probe({ scrollWidth: 1280 })) as any).horizontalOverflow).toBe(false);
  });
});
