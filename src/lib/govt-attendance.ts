// Government portal attendance import (2026-08-12, Manish's sample: "Attendance_till 11 Aug.csv").
//
// The portal exports a CUMULATIVE per-person summary for a period — not a day-wise register:
//   Sl No · Org Name · Attendance Id · Name · Candidate ID · Candidate Type · User's Designation ·
//   Total Working days · Total Days Present · Total Days Came After hh:mm:ss ·
//   Total Days Going Before hh:mm:ss · Total Hours Spent · Not Closed · Average Per Day · Details
// The trailing "Details" cell is a multi-line quoted blob, so the file MUST go through a real
// CSV parser — `parseCsv` already keeps newlines inside quotes, which is why it is reused here
// rather than a split("\n").
//
// The boss's ask was "Manish जिस भी format में upload करे, system पढ़ ले और match कर ले", so the
// column resolver works off normalised aliases rather than fixed positions: a portal that renames
// "Total Days Present" to "Days Present" still imports.
import * as XLSX from "xlsx";
import { parseCsv } from "@/lib/sync";
import { BatchMember, Candidate, DailyLog, Location, Trainer } from "@/models";

export type GovtRow = {
  sl_no: number | null;
  org_name: string;
  tc_id: string;
  attendance_id: string;
  name: string;
  govt_candidate_id: string;
  candidate_type: string;   // Trainee | Trainer
  designation: string;
  total_working_days: number | null;
  total_days_present: number | null;
  total_hours_minutes: number | null;
  total_hours_raw: string;
  average_per_day_raw: string;
  not_closed: number | null;
};

// ---------- header resolution ----------

const norm = (s: unknown) => String(s ?? "").replace(/ /g, " ").trim().toLowerCase().replace(/[\s_]+/g, " ");

// First alias that the header cell *starts with* wins — "total days came after 00:00:00" carries a
// clock value in the header itself, so exact equality would fail on every portal export.
const COLUMNS: Record<keyof GovtRow | "came_after" | "going_before", string[]> = {
  sl_no: ["sl no", "s no", "sr no", "serial no", "#"],
  org_name: ["org name", "organisation name", "organization name", "tc name", "centre name", "center name"],
  tc_id: ["tc id", "tc code", "centre id", "center id"],
  attendance_id: ["attendance id", "attendance"],
  name: ["name", "candidate name", "trainee name", "full name", "participant name"],
  govt_candidate_id: ["candidate id", "candidate code", "can id", "sdms id", "candidate reference"],
  candidate_type: ["candidate type", "type", "user type"],
  designation: ["user's designation", "users designation", "designation", "role"],
  total_working_days: ["total working days", "working days", "total days"],
  total_days_present: ["total days present", "days present", "present days", "no of days present"],
  total_hours_minutes: ["total hours spent", "hours spent", "total hours"],
  total_hours_raw: [],
  average_per_day_raw: ["average per day", "avg per day", "average hours per day"],
  not_closed: ["not closed", "not closed days"],
  came_after: ["total days came after", "days came after"],
  going_before: ["total days going before", "days going before"],
};

function resolveHeader(header: string[]): Record<string, number> {
  const cells = header.map(norm);
  const idx: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    if (!aliases.length) continue;
    // Longest alias first so "candidate id" is not stolen by the bare "name"/"type" aliases.
    for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
      const at = cells.findIndex((c, i) => !Object.values(idx).includes(i) && (c === alias || c.startsWith(alias + " ")));
      if (at >= 0) { idx[field] = at; break; }
    }
  }
  return idx;
}

// The register may sit under a title/filter block, so the header is found by content.
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map(norm);
    const hasName = cells.some((c) => COLUMNS.name.includes(c));
    const hasPresent = cells.some((c) => COLUMNS.total_days_present.some((a) => c === a || c.startsWith(a + " ")));
    const hasId = cells.some((c) => COLUMNS.govt_candidate_id.some((a) => c === a));
    if (hasName && (hasPresent || hasId)) return i;
  }
  return -1;
}

// ---------- value coercion ----------

const toNum = (v: unknown): number | null => {
  const s = String(v ?? "").trim().replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// "13:19:33" → 799.55 minutes. Portal hour totals routinely exceed 24h, so this is a duration,
// never a clock time — do not route it through Date.
//
// -106: a live production import (Bhadohi SPIT-01, "Attendance Report 06-08-2026") carries the same
// column as DECIMAL HOURS — "26.6", "73.99", "109.94" — not hh:mm:ss. Only the colon form parsed, so
// all 28 matched rows stored `null` minutes and every one of them read "— no hours" on the new
// qualification column: a whole live batch that could not be judged, including students clearly past
// the 60-hour bar. Found by smoking the -102 column against real production imports rather than
// fixtures. Both shapes are the same measurement, so both are read here — the one place the whole
// app converts this figure.
export function hhmmssToMinutes(v: unknown): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0);
  // Decimal hours: "73.99" → 4439.4 minutes. Deliberately strict — a bare integer or decimal only,
  // so a stray date, id or "N/A" still returns null rather than becoming a silent hour figure.
  const dec = /^(\d{1,5})(?:[.,](\d{1,4}))?$/.exec(s);
  if (dec) {
    const hours = Number(`${dec[1]}.${dec[2] ?? 0}`);
    if (!Number.isFinite(hours)) return null;
    // A programme is 120 hours; anything past a few thousand is not an hour count.
    if (hours > 10_000) return null;
    return hours * 60;
  }
  return null;
}

export function minutesToHhmm(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "—";
  const h = Math.floor(min / 60);
  return `${h}:${String(Math.round(min - h * 60)).padStart(2, "0")}`;
}

// "AVPL Gurugram -TC352854" → "TC352854". The portal glues the TC code onto the org name.
export function extractTcId(...sources: string[]): string {
  for (const s of sources) {
    const m = /\bTC\s*[-–]?\s*(\d{4,})\b/i.exec(String(s ?? ""));
    if (m) return `TC${m[1]}`;
  }
  return "";
}

// ---------- parsing ----------

// -106: `missing_columns` names the expected fields this file did NOT carry. Without it, a portal
// export whose hours or days-present column is named something we do not know imports "successfully"
// and then shows a whole batch of blanks — which is what a live Bhadohi import was doing. The screen
// can now say "this file has no Total Days Present column" instead of leaving the operator to guess
// whether the data or the reader is at fault.
export type ParsedFile = { rows: GovtRow[]; header: string[]; skipped: number; org_name: string; tc_id: string; missing_columns: string[] };

export function parseGovtAttendance(buf: Buffer, fileName = ""): ParsedFile {
  let grid: string[][];
  const isXlsx = /\.xlsx?$/i.test(fileName) || (buf[0] === 0x50 && buf[1] === 0x4b) || (buf[0] === 0xd0 && buf[1] === 0xcf);
  if (isXlsx) {
    const wb = XLSX.read(buf, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false });
  } else {
    grid = parseCsv(buf.toString("utf8").replace(/^﻿/, ""));
  }

  const h = findHeaderRow(grid);
  if (h < 0) {
    throw new Error("Could not find the attendance header row — expected a row with 'Name' and 'Total Days Present' (or 'Candidate ID').");
  }
  const header = grid[h];
  const idx = resolveHeader(header);
  if (idx.name === undefined) throw new Error("The file has no 'Name' column.");

  const at = (r: string[], f: string) => (idx[f] === undefined ? "" : String(r[idx[f]] ?? "").trim());
  const rows: GovtRow[] = [];
  let skipped = 0;
  for (const r of grid.slice(h + 1)) {
    const name = at(r, "name");
    // Portal exports end with blank spacer rows and sometimes a "Total" footer.
    if (!name || /^totals?$/i.test(name)) { if (r.some((c) => String(c ?? "").trim())) skipped++; continue; }
    const org = at(r, "org_name");
    rows.push({
      sl_no: toNum(at(r, "sl_no")),
      org_name: org,
      tc_id: extractTcId(at(r, "tc_id"), org),
      attendance_id: at(r, "attendance_id"),
      name,
      govt_candidate_id: at(r, "govt_candidate_id"),
      candidate_type: at(r, "candidate_type"),
      designation: at(r, "designation"),
      total_working_days: toNum(at(r, "total_working_days")),
      total_days_present: toNum(at(r, "total_days_present")),
      total_hours_minutes: hhmmssToMinutes(at(r, "total_hours_minutes")),
      total_hours_raw: at(r, "total_hours_minutes"),
      average_per_day_raw: at(r, "average_per_day_raw"),
      not_closed: toNum(at(r, "not_closed")),
    });
  }
  const org_name = rows.find((r) => r.org_name)?.org_name ?? "";
  // Which expected columns this file simply does not have. Reported, never guessed at: adding
  // speculative aliases is how a "Total" footer column starts being read as somebody's hours.
  const LABEL: Record<string, string> = {
    total_days_present: "Total Days Present", total_working_days: "Total Working Days",
    total_hours_minutes: "Total Hours Spent", govt_candidate_id: "Candidate ID",
    candidate_type: "Candidate Type", org_name: "Org Name",
  };
  const cols = COLUMNS as Record<string, string[]>;
  const missing_columns = Object.keys(LABEL).filter((k) => cols[k]?.length && idx[k] === undefined).map((k) => LABEL[k]);
  return { rows, header, skipped, org_name, tc_id: extractTcId(org_name), missing_columns };
}

// ---------- matching ----------

// Names arrive with portal-side spacing/case noise and the odd honorific.
const nameKey = (s: string) =>
  String(s ?? "").toLowerCase().replace(/\b(mr|mrs|ms|md|shri|smt|kumari)\.?\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

export type MatchStatus = "Matched" | "Ambiguous" | "Unmatched";
export type MatchedRow = GovtRow & {
  candidate?: unknown; trainer?: unknown; batch?: unknown; batch_member?: unknown;
  match_status: MatchStatus; match_by: string; match_note?: string;
  internal_days_present?: number | null; variance_days?: number | null;
};

/**
 * Match every parsed row to an ERP candidate (or trainer), preferring the portal's own
 * candidate ID and falling back to the name. Scope is the batch when one is given, else the
 * location — never the whole database, because trainee names repeat across centres (this very
 * sample carries two "Sachin Kumar" rows).
 */
export async function matchGovtRows(
  rows: GovtRow[],
  scope: { batchId?: string | null; locationId?: unknown },
): Promise<MatchedRow[]> {
  const memberFilter: Record<string, unknown> = scope.batchId ? { batch: scope.batchId } : {};
  let members: any[] = [];
  if (scope.batchId) {
    members = await BatchMember.find(memberFilter).populate("candidate", "name phone sidh_candidate_id").lean<any[]>();
  } else if (scope.locationId) {
    const cands = await Candidate.find({ location: scope.locationId }).select("_id name sidh_candidate_id").lean<any[]>();
    const ids = cands.map((c) => c._id);
    const mem = await BatchMember.find({ candidate: { $in: ids } }).select("_id batch candidate").lean<any[]>();
    const byCand = new Map(mem.map((m) => [String(m.candidate), m]));
    members = cands.map((c) => ({ ...(byCand.get(String(c._id)) ?? {}), candidate: c }));
  }

  const byGovtId = new Map<string, any[]>();
  const byName = new Map<string, any[]>();
  for (const m of members) {
    const c = m.candidate;
    if (!c) continue;
    if (c.sidh_candidate_id) {
      const k = String(c.sidh_candidate_id).trim().toUpperCase();
      byGovtId.set(k, [...(byGovtId.get(k) ?? []), m]);
    }
    const nk = nameKey(c.name);
    if (nk) byName.set(nk, [...(byName.get(nk) ?? []), m]);
  }

  const trainers = await Trainer.find(scope.locationId ? {} : {}).select("_id name govt_candidate_id").lean<any[]>();
  const trainerByName = new Map<string, any[]>();
  const trainerByGovtId = new Map<string, any>();
  for (const t of trainers) {
    const nk = nameKey(t.name);
    if (nk) trainerByName.set(nk, [...(trainerByName.get(nk) ?? []), t]);
    if (t.govt_candidate_id) trainerByGovtId.set(String(t.govt_candidate_id).trim().toUpperCase(), t);
  }

  const out: MatchedRow[] = [];
  for (const r of rows) {
    const gid = r.govt_candidate_id.trim().toUpperCase();
    const nk = nameKey(r.name);
    const isTrainer = /trainer/i.test(r.candidate_type) || /trainer/i.test(r.designation);

    if (isTrainer) {
      const t = (gid && trainerByGovtId.get(gid)) || (trainerByName.get(nk)?.length === 1 ? trainerByName.get(nk)![0] : null);
      out.push({
        ...r, trainer: t?._id,
        match_status: t ? "Matched" : "Unmatched",
        match_by: t ? (gid && trainerByGovtId.get(gid) ? "Portal ID" : "Name") : "",
        match_note: t ? undefined : `No trainer named "${r.name}" in the ERP.`,
      });
      continue;
    }

    let hits: any[] = [];
    let by = "";
    if (gid && byGovtId.has(gid)) { hits = byGovtId.get(gid)!; by = "Portal ID"; }
    else if (nk && byName.has(nk)) { hits = byName.get(nk)!; by = "Name"; }

    if (hits.length === 1) {
      out.push({ ...r, candidate: hits[0].candidate?._id ?? hits[0].candidate, batch: hits[0].batch, batch_member: hits[0]._id, match_status: "Matched", match_by: by });
    } else if (hits.length > 1) {
      out.push({ ...r, match_status: "Ambiguous", match_by: by, match_note: `${hits.length} candidates share this ${by.toLowerCase()} — set the portal Candidate ID on the right record to resolve.` });
    } else {
      out.push({
        ...r, match_status: "Unmatched", match_by: "",
        match_note: gid ? `No candidate carries portal ID ${r.govt_candidate_id}.` : `No candidate named "${r.name}" in this ${scope.batchId ? "batch" : "centre"}.`,
      });
    }
  }
  return out;
}

/**
 * Rule 30 extended: the portal's day count is the contractual one, so every matched row is
 * reconciled against what the centre actually logged. A positive variance means the portal
 * credits MORE days than our own daily logs do — the direction that costs the client money and
 * therefore the one an auditor asks about.
 */
export async function reconcileAgainstLogs(rows: MatchedRow[]): Promise<MatchedRow[]> {
  const memberIds = rows.map((r) => r.batch_member).filter(Boolean);
  if (!memberIds.length) return rows;
  const batchIds = [...new Set(rows.map((r) => String(r.batch)).filter((b) => b && b !== "undefined"))];
  const logs = await DailyLog.find({ batch: { $in: batchIds } }).select("batch present_member_ids").lean<any[]>();

  const presentCount = new Map<string, number>();
  for (const l of logs) for (const id of l.present_member_ids ?? []) {
    const k = String(id);
    presentCount.set(k, (presentCount.get(k) ?? 0) + 1);
  }
  return rows.map((r) => {
    if (!r.batch_member) return r;
    const internal = presentCount.get(String(r.batch_member)) ?? 0;
    return {
      ...r,
      internal_days_present: internal,
      variance_days: r.total_days_present == null ? null : r.total_days_present - internal,
    };
  });
}

// The centre the file belongs to, resolved from the TC code the portal stamps into Org Name.
export async function resolveLocationFromFile(parsed: ParsedFile) {
  if (!parsed.tc_id) return null;
  return Location.findOne({ external_id: new RegExp(`^${parsed.tc_id}$`, "i") }).select("_id name external_id").lean<any>();
}
