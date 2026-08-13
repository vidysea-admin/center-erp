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

// 2026-08-13 (Manish: "har row ke bagal mein us source ka link zaroor chahiye — taaki pata rahe
// yeh data galat hai, hallucinated hai, ya exact accurate hai"). Every sheet-imported row carries
// a source string of the form "AVPL <tab name>"; this maps it to the exact tab in the client's
// workbook. The gids were read from the live workbook's own tab list, never guessed — a tab the
// client renames simply falls back to the workbook root instead of opening the wrong data.
const AVPL_WORKBOOK = "https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf/edit";
const SHEET_TAB_GIDS: Record<string, string> = {
  // Location_Master is NOT here on purpose — its truth lives in the OneDrive workbook below.
  "Batch_Master": "339604985", "Trainer_Master": "1042692449",
  "Target_Planning": "926163080", "Back-dated Planning": "99229063", "Trainer_Nomination": "1430347160",
  "Gurugram - 6th July Batch": "120823275", "Gurugram - 28th July Batch": "1004322046",
  "30th July Registrations": "1418332621", "Lead": "1655710033", "Rough": "1145519390",
  "Resumes": "1283808537", "Registered Trainers": "111260260",
};

// 2026-08-13 (Umesh): "iss [OneDrive] sheet ke exact column and data chahiye — the only
// source of truth" for Location Master. Its source link therefore opens the OneDrive
// workbook, NOT our Google copy; every other tab still lives in the Google workbook.
const ONEDRIVE_RPL =
  "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE";

// "AVPL Batch_Master" → { tab, url }. Anything not recognisably from the workbook returns null,
// and the UI then says "Entered in ERP" instead of inventing a provenance.
export function sourceLink(source?: string | null): { tab: string; url: string } | null {
  const s = String(source ?? "").trim();
  if (!s) return null;
  const tab = s.replace(/^AVPL\s+/i, "");
  if (tab === "Location_Master") return { tab: "Vidysea-RPL (OneDrive)", url: ONEDRIVE_RPL };
  const gid = SHEET_TAB_GIDS[tab];
  if (gid) return { tab, url: `${AVPL_WORKBOOK}?gid=${gid}#gid=${gid}` };
  if (/^AVPL\b/i.test(s)) return { tab, url: AVPL_WORKBOOK }; // known workbook, unknown tab
  return null;
}

export function toInputDate(d?: string | Date | null): string {
  if (!d) return "";
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
