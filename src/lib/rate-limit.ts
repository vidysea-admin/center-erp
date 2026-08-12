import { HttpError } from "@/lib/authz";

// 2026-08-12 audit (auth S2-14). The public signup and register routes each carried their own
// copy of a limiter keyed on the LEFT-most x-forwarded-for value — which the client sets, so an
// attacker rotates it on every request and is never limited, while every honest caller behind a
// proxy is bucketed under one shared key. The Map also never evicted, so it grew for the life of
// the process. Both copies are consolidated here so the keying is fixed in one place.
//
// A durable cross-container store (Redis) is the complete answer and is deferred with the rest of
// the infra work; this keeps it per-process but no longer trivially bypassable and no longer a
// slow leak. That is the honest scope: it raises the cost of abuse, it does not defeat a
// distributed attacker.

// Behind our single nginx, X-Forwarded-For reaches the app as "<anything the client sent>,
// <the address nginx actually saw>". nginx APPENDS the real peer on the right, so the right-most
// entry is the one hop we can trust; the left-most is attacker-controlled. Take the right-most.
export function clientKey(req: { headers: { get(name: string): string | null } }): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers.get("x-real-ip")?.trim() || "local";
}

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export function rateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();

  // Opportunistic eviction: at most once a minute, drop every window that has fully elapsed, so
  // the Map cannot grow without bound. Cheap because it only runs on the minute boundary.
  if (now - lastSweep > 60_000) {
    for (const [k, b] of buckets) if (now - b.windowStart > windowMs) buckets.delete(k);
    lastSweep = now;
  }

  const b = buckets.get(key);
  if (!b || now - b.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return;
  }
  b.count++;
  if (b.count > max) throw new HttpError(429, "Too many attempts — please try again later.");
}
