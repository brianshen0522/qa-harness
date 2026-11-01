import { lookup } from "node:dns/promises";
import net from "node:net";

/** Metadata endpoints outside link-local: Azure wireserver, Alibaba, Oracle. */
const METADATA_IPS = new Set(["168.63.129.16", "100.100.100.200", "192.0.0.192"]);

/**
 * SSRF guard for fetching attacker-influenced URLs (discussion links). Blocks
 * loopback, link-local (incl. cloud metadata 169.254.169.254), private and ULA
 * ranges, and the unspecified address — after DNS resolution, so a public name
 * that resolves to an internal IP is still rejected. Self-hosted deployments that
 * intentionally fetch internal docs can opt back in with ALLOW_PRIVATE_FETCH=true.
 */
export function isBlockedIp(ip: string): boolean {
  const v4 = embeddedIpv4(ip);
  if (v4) {
    if (METADATA_IPS.has(v4)) return true;
    const [a, b, c] = v4.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 0) return true; // unspecified / this-host
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true; // loopback / unspecified
  if (v6.startsWith("fe80") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return true; // link-local fe80::/10
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique-local fc00::/7
  if (/^fe[c-f]/.test(v6)) return true; // deprecated site-local fec0::/10
  if (v6.startsWith("ff")) return true; // multicast ff00::/8
  return false;
}

/**
 * The IPv4 address an IP literal really reaches: itself, or the one embedded in
 * an IPv6 form that routes to it (mapped, compatible, NAT64, 6to4). URL parsing
 * rewrites these to hex (::ffff:7f00:1), so a dotted-only check misses them.
 */
function embeddedIpv4(ip: string): string | null {
  if (net.isIPv4(ip)) return ip;
  const words = ipv6Words(ip);
  if (!words) return null;
  const dotted = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeros = (from: number, to: number) => words.slice(from, to).every((w) => w === 0);
  if (zeros(0, 5) && words[5] === 0xffff) return dotted(words[6], words[7]); // ::ffff:0:0/96
  if (zeros(0, 6) && (words[6] !== 0 || words[7] > 1)) return dotted(words[6], words[7]); // ::/96
  if (words[0] === 0x64 && words[1] === 0xff9b && zeros(2, 6)) return dotted(words[6], words[7]); // NAT64
  if (words[0] === 0x2002) return dotted(words[1], words[2]); // 6to4
  return null;
}

/** The eight 16-bit groups of an IPv6 literal, or null if it isn't one. */
function ipv6Words(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let text = ip.split("%")[0];
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? Array(8 - left.length - right.length).fill("0") : [];
  return [...left, ...fill, ...right].map((w) => parseInt(w, 16));
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

/**
 * Link-local holds the cloud metadata endpoint, which is never a test target. A
 * Target on a private address is normal, so this is the one range refused even
 * for the Target's own origin. ALLOW_PRIVATE_FETCH opts out, as everywhere else.
 */
export async function assertNotLinkLocal(rawUrl: string, allowPrivate = false): Promise<void> {
  if (allowPrivate) return;
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const addr of addrs) {
    const v4 = embeddedIpv4(addr);
    if (v4 ? v4.startsWith("169.254.") || METADATA_IPS.has(v4) : /^fe[89ab]/i.test(addr)) {
      throw new Error("拒絕連線到 link-local 位址(SSRF 防護)");
    }
  }
}
