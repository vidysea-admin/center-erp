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

// mtg-a3 R7 (Umesh, 2026-10-06 meeting): a cost POST carries a client-generated idempotency key, so
// a double click or a retry after a dropped response (in the same tab - sessionStorage is per tab, so
// a second tab holds its own key) cannot post the same cost twice
// (Manish's existing duplicates came from exactly that). The key lives in sessionStorage for as long
// as THIS payload is unsent or unconfirmed: the same payload retried reuses it, an EDITED payload
// gets a fresh one (a different cost must never be answered with an earlier cost's result), and a
// success clears it. The server stores it per user and returns the first result for a repeat.
const COST_IDEM_PREFIX = "erp-cost-idem:";
function newIdemKey(): string {
  const c: any = typeof crypto !== "undefined" ? crypto : null;
  return c?.randomUUID ? c.randomUUID() : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
export function costIdempotencyKey(scope: string, payload: unknown): string {
  const slot = COST_IDEM_PREFIX + scope;
  const fp = JSON.stringify(payload ?? null);
  try {
    const raw = sessionStorage.getItem(slot);
    if (raw) {
      const saved = JSON.parse(raw) as { fp?: string; key?: string };
      if (saved.key && saved.fp === fp) return saved.key;
    }
  } catch { /* storage blocked or unreadable: fall through to a fresh key */ }
  const key = newIdemKey();
  try { sessionStorage.setItem(slot, JSON.stringify({ fp, key })); } catch { /* private mode: the key still protects this one call */ }
  return key;
}
export function clearCostIdempotencyKey(scope: string): void {
  try { sessionStorage.removeItem(COST_IDEM_PREFIX + scope); } catch { /* nothing to clear */ }
}
// The one way a screen posts a cost: scope names the form ("costs-page", "batch-costs:<id>").
export async function postCost<T = any>(scope: string, json: Record<string, unknown>): Promise<T> {
  const key = costIdempotencyKey(scope, json);
  const res = await api<T>("/api/costs", { method: "POST", json, headers: { "Idempotency-Key": key } });
  clearCostIdempotencyKey(scope); // success (created or queued) - the next entry is a new one
  return res;
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

// 2026-08-14 (CEO recorded review): the stored stage names ARE the display vocabulary —
// renamed in the DB enum during the post-wipe empty window, so there is no label layer left
// to drift from the data (the QA-045 bug class). The helper survives as a null-guard only.
export const pipelineLabel = (s?: string | null) => s ?? "—";

/**
 * Which rows of a master may be OFFERED when something new is created.
 *
 * Retiring is a decision about what may be STARTED, not about history — so a retired row leaves the
 * creation pickers while every record already pointing at one keeps working, and the row currently
 * selected is always kept so editing an old record never blanks its own field.
 *
 * -129 (QA-271): this existed three times, copy-pasted into batches/page.tsx, candidates/page.tsx
 * and locations/[id]/page.tsx, and in all three it was only ever handed `programs`. Location was
 * the one master with no `active` flag at all, which is how a placeholder centre called "yet to be
 * identify" stayed selectable. One copy now, so the next master to need it does not make a fourth.
 */
export function offerable<T extends { _id?: unknown; active?: boolean }>(list: T[], selected?: unknown): T[] {
  // `selected` may be one id or several — candidates/ feeds this multi-selects (interested_locations,
  // interested_programs), the rest single selects. Taking both is why there is one of these now.
  const keep = new Set((Array.isArray(selected) ? selected : [selected]).map((x) => String(x ?? "")));
  return (list ?? []).filter((p) => p?.active !== false || keep.has(String(p?._id)));
}

// -235: this expression already existed TWICE inside batches/[id]/page.tsx (:263 and :1592) and a third
// copy was about to be written for the roster's join-date box. It is the IST calendar day as the
// YYYY-MM-DD an <input type="date"> understands — the client-side twin of rules.ts `istToday()`, which is
// what the server actually compares a submitted date against. Two spellings of "today" on the two sides
// of one date field is how a `max=` that looks right starts refusing a date the server would have taken.
// 2026-08-25 (QA-1123): the sentence above did not hold — a FOURTH copy was written anyway, in
// trainers/[id]/page.tsx, in a file that already imported from this module (its author used the
// 330*60_000 spelling, so no grep for this function's own body would have found it). Collapsed, and
// the census is now a check-user-copy.mjs pin: one declaration here, no inline IST-shift outside
// this file and rules.ts's istToday (the server twin — pinned EQUAL to this one, never merged).
export function istTodayInput(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function toInputDate(d?: string | Date | null): string {
  if (!d) return "";
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

// QA-2792: an AuditLog old_value/new_value used to always be a plain scalar, so JSON.stringify-ing
// it read as one quoted sentence. QA-2736's batch-delete widened new_value to
// `{ summary, snapshot }` (AuditLog.new_value is Schema.Types.Mixed) — richer on disk for an
// auditor, but the two activity renderers (components/activity.tsx, admin/page.tsx) JSON.stringify'd
// the whole object, so the line a person actually reads went from a sentence to a raw blob:
// ObjectIds, ISO timestamps, nested counts. A batch delete is exactly the event someone goes
// looking for, because the record itself is gone — that is the one line that most needs to stay
// readable.
//
// Went and looked, per this unit's brief, rather than assuming batch-delete is the only
// object-valued audit: it is not. approvals.ts stages `{ deleted: true, reason }` and
// `{ decision, approved_amount }`, rules.ts stages `{ joined_on, enrollment_status }`,
// members/[id]/route.ts stages `{ status, reg, kyc, enroll, accept, issue }`,
// results/[id]/(reassess/)route.ts stage assessment/certificate fields, approvals/route.ts stages
// `{ enabled, approver_role, approver_users }`, bulk-enroll stages step counts — NONE of those carry
// a `summary` string, and none of them carry raw ObjectIds or Date instances either (they are
// short-field decision/status objects, not entity snapshots). Only the two batch-delete sites
// (QA-2736) opted into the richer `{ summary, snapshot }` shape, specifically so a human sentence
// could keep riding alongside the auditor's structured snapshot.
//
// So the rule this function encodes is narrow on purpose: prefer `.summary` when the value is an
// object that actually carries one (a string on that exact key); every other shape — string,
// number, null, array, or a plain field-diff object with no summary — renders exactly as it did
// before this fix (JSON.stringify), which is a readable one-line diff for those smaller shapes and
// an unchanged, non-regressing rendering for every audit row this unit does not own.
export function fmtAuditValue(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { summary?: unknown }).summary === "string") {
    return (v as { summary: string }).summary;
  }
  return JSON.stringify(v);
}

// costs-approval-box (Umesh, 2026-10-19: "top box with filters ... along with home page too").
// WHO MAY DECIDE A PARKED COST, for the two screens that SHOW the shortcut (Costs box, Home card).
// This is the CLIENT mirror of the three checks `POST /api/approvals/[id]` runs for a cost.post
// request - `requirePerm(approvals.decide)` and `requireFinance(approve)`, which is finance.view
// plus finance.approve at edit level (api/approvals/[id]/route.ts). It decides only whether the
// shortcut is DRAWN; the server still refuses every decision it does not allow, and the per-row
// role / named-approver / own-request rules are applied by the box row by row. One definition,
// because the same three-key sentence written separately on two screens is how a gate drifts.
export function canDecideCostApprovals(can: (key: string, level?: "view" | "edit") => boolean): boolean {
  return can("approvals.decide", "edit") && can("finance.view") && can("finance.approve", "edit");
}

// QA-2958 (F1, senior review of the Costs approval box): the partial-amount box on Admin -> Approvals
// and on the Costs approval box was `<input type="number">` and the decide call did
// `amount ? { approved_amount: Number(amount) } : {}`. A browser hands a number input's `.value` back as
// "" for text it cannot parse ("3,000", "Rs 3000"), and `Number("3,000")` is NaN, which JSON writes as
// `null` - so the server saw NO amount and approved the FULL requested figure. An approver who meant
// "less" silently sanctioned "all". ONE rule for both screens, so the two cannot drift again.
//
// QA-2958 (Umesh, 2026-10-25, verbatim in qa/feedback-inbox.md): "daalne hi mat do, integer or float
// allow krro bss". F1 first answered by READING commas / rupee signs ("3,000" -> 3000). That is withdrawn:
// the box now refuses the INPUT itself and never rewrites what the approver typed. Two halves:
//   1. TYPING - `partialAmountTypingOk(next)`: the field may only ever hold digits with at most one dot
//      (a half-typed "3." or "." is allowed while typing). Any keystroke / paste / drop that would make
//      the field hold anything else is not entered (the caller keeps the previous value), and
//      `partialAmountPasteBlocked` rejects a whole paste, so "3,000" is never turned into "3000" for them.
//   2. SUBMIT - `parsePartialAmount(raw)`: returns the positive amount, or null when the text is not a
//      plain integer / decimal (a lone ".", "3.", ".5", "0", more than two decimals). The callers send
//      NOTHING on null. An EMPTY box is not this function's business: the callers keep "empty = approve
//      in full". When `requested` is given, an amount above it is also refused.
export const partialAmountTypingOk = (next: string): boolean => /^\d*\.?\d*$/.test(next);
export function partialAmountPasteBlocked(e: { clipboardData: { getData(f: string): string } | null; currentTarget: HTMLInputElement; preventDefault(): void }): boolean {
  const pasted = e.clipboardData?.getData("text") ?? "";
  const el = e.currentTarget;
  const from = el.selectionStart ?? el.value.length;
  const to = el.selectionEnd ?? from;
  if (partialAmountTypingOk(el.value.slice(0, from) + pasted + el.value.slice(to))) return false;
  e.preventDefault();
  return true;
}
export function parsePartialAmount(raw: unknown, requested?: number): number | null {
  if (typeof raw !== "string") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  if (requested !== undefined && Number.isFinite(requested) && n > requested) return null;
  return n;
}

export const PARTIAL_AMOUNT_UNCLEAR = "Amount samajh nahi aaya - sirf number likhiye, jaise 3000";
