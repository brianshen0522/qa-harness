import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * SSRF guard for fetching attacker-influenced URLs (discussion links). Blocks
 * loopback, link-local (incl. cloud metadata 169.254.169.254), private and ULA
 * ranges, and the unspecified address — after DNS resolution, so a public name
 * that resolves to an internal IP is still rejected. Self-hosted deployments that
 * intentionally fetch internal docs can opt back in with ALLOW_PRIVATE_FETCH=true.
 */
export function isBlockedIp(ip: string): boolean {
  // Normalise IPv4-mapped IPv6 (::ffff:10.0.0.1) to its IPv4 form.
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 0) return true; // unspecified / this-host
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true; // loopback / unspecified
  if (v6.startsWith("fe80") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return true; // link-local fe80::/10
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique-local fc00::/7
  return false;
}

/** Throws if the URL is not http(s) or resolves to a blocked address. */
export async function assertPublicUrl(rawUrl: string, allowPrivate = false): Promise<URL> {
  const u = new URL(rawUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支援 http/https");
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length) throw new Error("無法解析主機");
  for (const addr of addrs) {
    if (isBlockedIp(addr)) throw new Error("拒絕連線到內網／保留位址(SSRF 防護)");
  }
  return u;
}
