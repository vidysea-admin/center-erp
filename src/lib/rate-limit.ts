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

// -110 (checker, QA-188): the per-IP limiter above is the right shape when a challenge is FREE to
// issue. An SMS is not — every code costs money and reaches a real phone — so a phone-OTP endpoint
// with only per-IP limits is an SMS-pumping (toll fraud) target: an attacker rotates IPs and has
// thousands of codes sent to numbers they profit from, on our bill. Three more gates, all keyed
// on the THING being paid for rather than on the caller:
//
//   1. per-phone cap — independent of IP, so rotating IPs does not help;
//   2. resend cooldown — the same number cannot be texted again inside a short window;
//   3. global daily cap — a hard ceiling on what the whole app will send in a day. When it trips,
//      sending STOPS and the caller is told to raise it to a human (a Notification), because a
//      silent stop is how the bill and the outage are both discovered a day late.
//
// Same in-process, self-evicting Map as above; same honest scope (raises the cost of abuse, does
// not defeat a distributed attacker — Redis is the complete answer and stays deferred).
export function phoneChallengeGate(phone: string, opts: {
  perPhoneMax?: number; perPhoneWindowMs?: number; cooldownMs?: number; dailyMax?: number;
} = {}): { ok: true } | { ok: false; reason: "cooldown" | "per_phone" | "daily_cap"; retryAfterSec?: number } {
  const perPhoneMax = opts.perPhoneMax ?? 5, perPhoneWindowMs = opts.perPhoneWindowMs ?? 60 * 60_000;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const dailyMax = opts.dailyMax ?? Number(process.env.SMS_DAILY_CAP ?? 500);
  const now = Date.now();
  const key = "sms-phone:" + phone;

  // resend cooldown — the LAST send to this number
  const last = buckets.get("sms-last:" + phone);
  if (last && now - last.windowStart < cooldownMs) {
    return { ok: false, reason: "cooldown", retryAfterSec: Math.ceil((cooldownMs - (now - last.windowStart)) / 1000) };
  }
  // per-phone window
  const p = buckets.get(key);
  if (p && now - p.windowStart <= perPhoneWindowMs && p.count >= perPhoneMax) {
    return { ok: false, reason: "per_phone", retryAfterSec: Math.ceil((perPhoneWindowMs - (now - p.windowStart)) / 1000) };
  }
  // global daily cap — one bucket for the whole process, 24h window
  const g = buckets.get("sms-daily");
  if (g && now - g.windowStart <= 24 * 3600_000 && g.count >= dailyMax) {
    return { ok: false, reason: "daily_cap" };
  }
  // all clear — count it
  if (!p || now - p.windowStart > perPhoneWindowMs) buckets.set(key, { count: 1, windowStart: now }); else p.count++;
  if (!g || now - g.windowStart > 24 * 3600_000) buckets.set("sms-daily", { count: 1, windowStart: now }); else g.count++;
  buckets.set("sms-last:" + phone, { count: 1, windowStart: now });
  return { ok: true };
}
