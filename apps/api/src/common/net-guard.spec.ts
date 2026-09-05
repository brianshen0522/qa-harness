import { isBlockedIp } from "./net-guard";

describe("isBlockedIp", () => {
  it("blocks loopback / private / link-local / metadata / ULA", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
});
