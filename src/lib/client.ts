"use client";
import { BASE_PATH } from "@/lib/base-path";

// Tiny fetch wrapper — throws Error with server's message on non-2xx.
// Prefixes the app's basePath (next/link does this automatically; raw fetch does not).
export async function api<T = any>(path: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = opts;
  const res = await fetch(path.startsWith("/") ? BASE_PATH + path : path, {
    ...rest,
    headers: json ? { "Content-Type": "application/json", ...(rest.headers || {}) } : rest.headers,
    body: json ? JSON.stringify(json) : rest.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

// Business dates are stored at UTC midnight — pinning the zone keeps the calendar date
// stable for a viewer west of UTC instead of showing yesterday.
export function fmtDate(d?: string | Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
}

// Timestamps (detected_at, imported_at, …) always render as IST wall-clock with am/pm —
// "13 Aug 2026, 2:45 pm" — the format the team reads, wherever the browser is.
export function fmtDT(d?: string | Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

export function toInputDate(d?: string | Date | null): string {
  if (!d) return "";
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
