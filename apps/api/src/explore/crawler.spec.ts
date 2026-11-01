process.env.DATABASE_URL ??= "postgresql://x:x@127.0.0.1:1/x";
process.env.USER_JWT_SECRET ??= "test";
process.env.CREDENTIAL_MASTER_KEY ??= "test";

import type { ComputerService } from "../sandbox/computer.service";
import { Crawler, type CrawlIdentity } from "./crawler";

function setup(identity: Partial<CrawlIdentity>) {
  const computer = {
    cdpNavigate: jest.fn().mockResolvedValue({ forms: [] }),
    cdpFill: jest.fn().mockResolvedValue({ ok: true }),
    cdpClick: jest.fn().mockResolvedValue({ ok: true }),
    cdpCurrent: jest.fn().mockResolvedValue({ url: "https://shop.test/home", path: "/home", title: "" }),
  };
  const crawler = new Crawler(computer as unknown as ComputerService, 1, "https://shop.test/");
  const events: { ok: boolean }[] = [];
  const run = () => crawler.login({
    id: "i", name: "admin", role: "admin", isAnonymous: false,
    credentials: { "a.username": "u", "a.password": "p" },
    login: { userKey: "a.username", passKey: "a.password" },
    ...identity,
  }, (e) => events.push(e as { ok: boolean }));
  return { computer, run, events };
}

describe("Crawler.login", () => {
  it("logs in on the Target's own site", async () => {
    const { computer, run } = setup({ login: { loginPath: "/signin", userKey: "a.username", passKey: "a.password" } });
    expect(await run()).toBe(true);
    expect(computer.cdpNavigate).toHaveBeenCalledWith(1, "https://shop.test/signin", 800);
    expect(computer.cdpFill).toHaveBeenCalledTimes(2);
  });

  it.each(["https://evil.test/login", "//evil.test/login", "https://shop.test.evil.test/login", "javascript:alert(1)"])(
    "never opens or fills an off-Target login path %s",
    async (loginPath) => {
      const { computer, run, events } = setup({ login: { loginPath, userKey: "a.username", passKey: "a.password" } });
      expect(await run()).toBe(false);
      expect(computer.cdpNavigate).not.toHaveBeenCalled();
      expect(computer.cdpFill).not.toHaveBeenCalled();
      expect(events[0].ok).toBe(false);
    },
  );

  it("allows an SSO site the owner listed", async () => {
    const { computer, run } = setup({
      login: { loginPath: "https://sso.corp.test/login", userKey: "a.username", passKey: "a.password" },
      credentialOrigins: ["https://sso.corp.test"],
    });
    await run();
    expect(computer.cdpFill).toHaveBeenCalledTimes(2);
  });
});
