// Outbound fetch guard for user-supplied URLs (2026-08-12, security review).
//
// Sheet sources are URLs a person types in. That makes every fetch of one a request the server
// makes on an attacker's behalf — classic SSRF — and this server runs on EC2, where
// http://169.254.169.254/ hands out IAM credentials to anything that asks. The leak is not
// theoretical here: XLSX.read parses ANY plain text as CSV, so an internal endpoint's response
// would come straight back out of the sheet-source probe as "columns", and a watch source
// pointed at it would keep exfiltrating on a timer.
//
// The guard therefore lives at the single choke point every sheet fetch passes through, rather
// than at the one route the review happened to flag — the poller reaches the same code.
//
// Adding a source needs the `sheet.sources` right, so this is not anonymous. It is still worth
// closing: that right is held by Operations, and "an Operations user can read the instance's
// IAM credentials" is a privilege escalation, not a feature.
// No static `node:dns` / `node:net` imports: this module is reachable from instrumentation.ts,
// which Next also traces for the Edge runtime, and a static Node-builtin import turns that trace
// into a build error. DNS is pulled in dynamically at call time instead, and IP-literal
// classification is done here rather than borrowing net.isIP.
//
// Turbopack still emits one Edge warning for the dynamic dns import. It is a false positive:
// instrumentation.ts returns immediately unless NEXT_RUNTIME === "nodejs", so nothing on the
// Edge path ever reaches a fetch, and both the poller and the API routes run under Node.
import { BASE_PATH } from "@/lib/base-path";

const MAX_REDIRECTS = 5;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipKind(s: string): 4 | 6 | 0 {
  if (IPV4.test(s)) return s.split(".").every((o) => Number(o) <= 255 && !/^0\d/.test(o)) ? 4 : 0;
  // Loose on purpose: anything containing a colon is treated as IPv6 and judged by the blocked
  // rules below. Being over-inclusive here fails closed, which is the direction to err.
  return s.includes(":") ? 6 : 0;
}

// Ranges that must never be reachable from a user-supplied URL. Blocking by resolved IP rather
// than by hostname is the point — "internal.example.com" and a DNS record pointing at
// 169.254.169.254 both land here.
function isBlockedIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||                              // 0.0.0.0/8 "this network"
    a === 10 ||                             // private
    a === 127 ||                            // loopback
    (a === 100 && b >= 64 && b <= 127) ||   // 100.64/10 carrier-grade NAT
    (a === 169 && b === 254) ||             // 169.254/16 link-local — the cloud metadata service
    (a === 172 && b >= 16 && b <= 31) ||    // private
    (a === 192 && b === 0) ||               // 192.0.0/24 IETF protocol assignments
    (a === 192 && b === 168) ||             // private
    (a === 198 && (b === 18 || b === 19)) ||// 198.18/15 benchmarking
    a >= 224                                // multicast + reserved + broadcast
  );
}

function isBlockedIPv6(ip: string): boolean {
  const v = ip.toLowerCase().split("%")[0]; // strip zone id
  if (v === "::" || v === "::1") return true;
  // IPv4-mapped addresses must be judged on their IPv4 value, not waved through. They arrive in
  // two spellings and BOTH have to be handled: a person types ::ffff:169.254.169.254, but the
  // WHATWG URL parser normalises the dotted quad to hextets, so url.hostname hands back
  // ::ffff:a9fe:a9fe. Matching only the readable form is a bypass, not a nicety.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) return isBlockedIPv4(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // Any other compressed form embedding an IPv4 tail (::a9fe:a9fe, ::169.254.169.254) is
  // refused outright rather than partially parsed — these are only ever used to smuggle.
  if (/^::[0-9a-f.:]+$/.test(v)) return true;
  return (
    v.startsWith("fc") || v.startsWith("fd") ||  // fc00::/7 unique-local
    v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || // fe80::/10 link-local
    v.startsWith("ff")                            // multicast
  );
}

export function isBlockedAddress(ip: string): boolean {
  const kind = ipKind(ip);
  if (kind === 4) return isBlockedIPv4(ip);
  if (kind === 6) return isBlockedIPv6(ip);
  return true; // not an IP literal at all — refuse rather than guess
}

export class BlockedUrlError extends Error {}

/**
 * Reject anything that is not a plain public web address, resolving DNS so a hostname cannot be
 * used to smuggle in an internal IP.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BlockedUrlError("That is not a valid link."); }

  // A data: URL is the sheet content itself — it causes no outbound request at all, so it is
  // not an SSRF vector and there is nothing to resolve.
  if (url.protocol === "data:") return url;

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedUrlError("Only http:// and https:// links can be fetched.");
  }

  // Narrow exception: a sheet uploaded INTO the ERP is served back by our own file route, and
  // syncing from it is a legitimate alternative to linking an external sheet. Scoped to loopback
  // AND to that one path, so it cannot be widened into "any internal address is reachable".
  const loopbackHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (loopbackHost && url.pathname.startsWith(`${BASE_PATH}/api/files/`)) return url;
  // Sheets are served over the standard web ports. Allowing arbitrary ports turns this into a
  // port scanner against whatever the server can reach.
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port !== "443" && port !== "80") {
    throw new BlockedUrlError("Only standard web ports (80 and 443) are allowed.");
  }
  // Credentials in the URL are a redirect-laundering trick and never needed for a shared sheet.
  if (url.username || url.password) throw new BlockedUrlError("Links with embedded credentials are not allowed.");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (ipKind(host)) {
    if (isBlockedAddress(host)) throw new BlockedUrlError("That address is on an internal network and cannot be fetched.");
    return url;
  }
  let records;
  try {
    const { lookup } = await import("node:dns/promises");
    records = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve "${host}" — check the link.`);
  }
  if (!records.length) throw new BlockedUrlError(`Could not resolve "${host}" — check the link.`);
  // EVERY resolved address must be public: one internal answer among several is enough for the
  // OS to pick it.
  for (const r of records) {
    if (isBlockedAddress(r.address)) {
      throw new BlockedUrlError("That link resolves to an internal address and cannot be fetched.");
    }
  }
  return url;
}

/**
 * fetch() with the guard applied to the initial URL and to every redirect hop.
 *
 * Redirects are followed by hand because `redirect: "follow"` would happily chase a public URL
 * into 169.254.169.254 — the check has to run again on each Location.
 */
// -98 (QA-163): /api/files now needs a login. The sync engine's loopback read of a sheet that
// was uploaded INTO the ERP is the one server-to-server consumer — it proves itself with a
// header only this process can mint (HMAC of the file NAME under AUTH_SECRET; never leaves the box).
export function internalFileToken(fileName: string): string {
  const secret = process.env.AUTH_SECRET || "";
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("crypto").createHmac("sha256", `erp-internal-files:${secret}`).update(fileName).digest("hex");
}
export const INTERNAL_FILE_HEADER = "x-erp-internal-file";
export async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  let target = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(target);
    const loopbackHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
    const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
    if (loopbackHost && url.pathname.startsWith(`${BASE_PATH}/api/files/`)) headers[INTERNAL_FILE_HEADER] = internalFileToken(url.pathname.split("/").pop() ?? "");
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      target = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  throw new BlockedUrlError("Too many redirects — the link keeps bouncing.");
}
