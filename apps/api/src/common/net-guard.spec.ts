import { assertNotLinkLocal, isBlockedIp } from "./net-guard";

describe("metadata addresses outside link-local", () => {
  it.each(["168.63.129.16", "100.100.100.200", "192.0.0.192"])("refuses %s everywhere", async (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
    expect(isBlockedIp(`::ffff:${ip}`)).toBe(true);
    await expect(assertNotLinkLocal(`http://${ip}/`)).rejects.toThrow();
  });
  it("keeps allowing an ordinary private Target", async () => {
    await expect(assertNotLinkLocal("http://10.0.0.5/")).resolves.toBeUndefined();
  });
});

describe("isBlockedIp", () => {
  it("blocks IPv6 multicast and site-local", () => {
    for (const ip of ["ff02::1", "fec0::1", "feff::1"]) expect(isBlockedIp(ip)).toBe(true);
  });
  it("blocks loopback / private / link-local / metadata / ULA", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("sees through IPv6 forms that reach an internal IPv4 address", () => {
    for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:169.254.169.254", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "0:0:0:0:0:ffff:0a00:0001"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("blocks the remaining reserved IPv4 ranges", () => {
    for (const ip of ["192.0.0.1", "198.18.0.1", "198.19.255.255", "224.0.0.1", "240.0.0.1", "255.255.255.255"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("still allows public addresses in an embedding form", () => {
    for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
});
