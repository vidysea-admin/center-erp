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
// -248 (QA-1217): the matcher below decides WHO MATCHES WHOM, and ARCHITECTURE.md section 3 names
// `normalizeCan` as the one test every such decision uses. This file already RE-EXPORTS it (see the
// `export { normalizeCan, looksLikeCan, storedCanIsUnreadable }` line below),
// but a re-export puts nothing in local scope — which is how this module ended up with its own
// weaker near-copy (`.trim().toUpperCase()`) doing the deciding. Imported here so there is one.
import { normalizeCan } from "@/lib/validate";
import { Batch, BatchMember, Candidate, DailyLog, GovtAttendanceRow, Location, Trainer } from "@/models";

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

// An alias matches a header cell exactly, or as a PREFIX of it — "total days came after 00:00:00"
// carries a clock value in the header itself, so exact equality alone would fail on every portal
// export. Read `resolveHeader` below before adding an alias: exact matches are settled first,
// across all fields, so a short prefix alias here can no longer steal a column that is somebody
// else's exact header (QA-1383).
const COLUMNS: Record<keyof GovtRow | "came_after" | "going_before", string[]> = {
  sl_no: ["sl no", "s no", "s.no", "sr no", "serial no", "#"],
  org_name: ["org name", "organisation name", "organization name", "tc name", "centre name", "center name"],
  tc_id: ["tc id", "tc code", "centre id", "center id"],
  attendance_id: ["attendance id", "attendance"],
  name: ["name", "candidate name", "trainee name", "full name", "participant name"],
  govt_candidate_id: ["candidate id", "candidate code", "can id", "sdms id", "candidate reference"],
  candidate_type: ["candidate type", "type", "user type"],
  designation: ["user's designation", "users designation", "designation", "role"],
  // -248 (QA-1219, Umesh 25/08, Chitrakoot "Attendance Report 22-08-2026"): the portal serves TWO
  // shapes under one feature. The raw AEBAS register ("Total Working days" / "Total Days Present" /
  // "Total Hours Spent") is the one this table was written for; SIDH also emits an "Attendance
  // Report" that states the QP entitlement and the AEBAS attendance side by side ("Total Training
  // Days (QP)" / "Total Days Attended" / "Total Hours Attended").
  //
  // What went wrong on Umesh's file: `total_working_days` claimed "Total Days Attended" through
  // its bare "total days" alias, so the batch denominator read 0/1/2 (a per-student attended count)
  // instead of 18 and `total_days_present` found nothing left and came back null on all 45 rows.
  // A null days-present column on every row is ALSO the column-shift signature (`shiftSignature`),
  // so the file was refused with "this file looks column-shifted". It was not shifted. A wrong
  // diagnosis an operator cannot act on is worse than none.
  //
  // -248 answered that by adding "total training days" (19 chars) so it out-sorted the bare "total
  // days" (10) — which worked only while the file HAD a QP column, and every fixture written for it
  // did. QA-1383 moved the guarantee into `resolveHeader` instead: exact matches are settled
  // across ALL fields before any prefix match may claim a column, so "Total Days Attended" goes to
  // the field whose alias spells it exactly, with or without a QP column beside it, and no matter
  // which field is declared first. Order here is no longer load-bearing — but keep it anyway, and
  // read `resolveHeader` below before adding an alias that is a prefix of another field's header.
  // On a genuine AEBAS export none of the three new aliases exist, so each falls through to the
  // alias it always used. That is asserted, not assumed — the fixture's parse is pinned byte-for-byte.
  total_working_days: ["total training days", "total working days", "working days", "total days"],
  total_days_present: ["total days attended", "total days present", "days present", "present days", "no of days present"],
  total_hours_minutes: ["total hours attended", "total hours spent", "hours spent", "total hours"],
  total_hours_raw: [],
  average_per_day_raw: ["average per day", "avg per day", "average hours per day"],
  not_closed: ["not closed", "not closed days"],
  came_after: ["total days came after", "days came after"],
  going_before: ["total days going before", "days going before"],
};

// QA-1383 (Umesh, 26/08 on batch 6a848c6c…f91): EVERY EXACT MATCH IS SETTLED BEFORE ANY
// PREFIX MATCH MAY CLAIM A COLUMN. That ordering is the whole fix, and here is what it cost to
// learn twice.
//
// A field used to take its column the moment its own turn came round, in the declaration order of
// COLUMNS. So `total_working_days`, which is declared first and carries the BARE PREFIX alias
// "total days", could claim a column headed literally **"Total Days Attended"** — an exact match
// for the field declared one line BELOW it. `total_days_present` then found nothing left and came
// back null on every row, and the per-student attended count sat in the batch-level working-days
// slot.
//
// -248 met this and fixed the file in front of it: SIDH's "Attendance Report" carries "Total
// Training Days (QP)", whose 19-character alias out-sorts "total days", so working-days took the
// QP column and days-present got its own. But the fix depended on that column BEING THERE, and
// every fixture written for it carried one. The same export without the QP column — which is what
// the portal served for the batch above — still lost days-present entirely:
//   Govt days read "— / 1" and "— / 2" (that 1 and 2 ARE the attended counts) and Days Attendance %
//   was blank on all 45 students.
// A blank column that means "the portal never said" is indistinguishable from one that means "we
// read your file into the wrong slot" — and it was the second.
//
// WHAT THIS COMMENT USED TO CLAIM NEXT, AND WHY IT IS GONE (QA-1394, cycle 2): it said the file
// "did not even trip `shiftSignature`, because that guard needs working-days to vary across more
// than two values and a young batch's attended counts are 0/1/2". Run the guard on those very
// numbers and it is self-refuting — {0,1,2} is THREE distinct values, so `distinct.length > 2`
// holds and the guard FIRES, which disables the Import button rather than passing quietly. So
// either the live counts were {1,2} and the "0/1/2" was wrong, or the guard fired and the operator
// clicked past it and the "silently" was wrong. **I cannot tell which**: production Mongo is
// read-only and IP-protected from here, and the uploaded file's header is not stored anywhere
// (`GovtAttendanceImportSchema` keeps file_name, org_name, tc_id, period_label and counts — no
// header). An inference dressed as a mechanism is exactly what the -248 block below was rewritten
// for, and cycle 1 shipped a fresh one beside it. **Whether the import was silent is unknown and
// stays unknown here.** What is measured is the parser, and the parser is what this fixes.
//
// So field order is no longer allowed to beat SPECIFICITY — in either pass. Two passes, one rule:
//
//   pass 1  every EXACT header match, across all fields, longest alias first
//   pass 2  every PREFIX match, across all fields, longest alias first
//
// Pass 2's cross-field ordering is cycle 2's correction (QA-1393, found by the checker). Cycle 1
// fixed only pass 1 and left pass 2 walking the declaration order — so the moment
// `total_days_present` took its exact column in pass 1, `total_working_days` arrived at pass 2 with
// its bare "total days" alias still live and, being declared FIRST, took the column headed
// "Total Days Came After 00:00:00" straight out of `came_after`'s hands. `came_after` and
// `going_before` are read by nothing in this tree; RESERVING those two clock columns so nobody else
// eats them is their entire job, and cycle 1's fix defeated the reservation in precisely the shape
// it was written for. Ranking pass 2 by alias length too puts "total days came after" (21) ahead of
// "total days" (10) and the reservation holds. (On one of those shapes the ORIGINAL code stole the
// clock column as well — this is not only a cycle-1 regression, it closes an older hole.)
//
// Measured across the two REAL portal fixtures and six adversarial shapes: `govt-attendance-sample.csv`
// (AEBAS, clock headers and all) and `govt-attendance-sidh-report.csv` (SIDH with QP) resolve
// byte-for-byte as they always did; only the misread shapes move. All pinned in scripts/e2e-govt.mjs.
function resolveHeader(header: string[]): Record<string, number> {
  const cells = header.map(norm);
  const idx: Record<string, number> = {};
  const taken = new Set<number>();
  // Longest alias first, ACROSS FIELDS, so "candidate id" is not stolen by the bare "name"/"type"
  // aliases and "total days came after" is not stolen by the bare "total days".
  const candidates = Object.entries(COLUMNS)
    .flatMap(([field, aliases]) => aliases.map((alias) => ({ field, alias })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const exact of [true, false]) {
    for (const { field, alias } of candidates) {
      if (idx[field] !== undefined) continue;
      const at = cells.findIndex((c, i) => !taken.has(i) && (exact ? c === alias : c.startsWith(alias + " ")));
      if (at >= 0) { idx[field] = at; taken.add(at); }
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
// takes `string | undefined` because it already guards for it -- the signature was the only thing
// pretending otherwise (-146, QA-316).
// -153 (QA-393): exported for the same reason isTrainerRow was (QA-045 - one test, two callers).
// The attendance surfaces need to ask "is there an unattached portal row for THIS person", and the
// only honest way to ask it is with the identical normalisation the matcher itself used to decide
// the row was ambiguous. A second, near-enough copy of this regex is how two screens start
// disagreeing about one student.
/**
 * -248 cycle 2 (QA-1226, raised by the CHECKER against cycle 1 — and it was right).
 *
 * Cycle 1 keyed the portal-ID index on `normalizeCan` alone. That is the shared matcher and using it
 * was the point of the unit, but it is `/CAN[\s_-]*(\d+)/i` — it reads only DIGITS after CAN, and
 * returns null for `CAN_ED0711202`, a shape `looksLikeCan` accepts and this product demonstrably
 * stores (QA-714, -210, and four e2e suites use it as a real portal id). So cycle 1 dropped those
 * candidates out of the index entirely and LOST AN EXACT MATCH THAT PREVIOUSLY WORKED: file and
 * candidate carrying the identical string `CAN_ED0711202` went from `Matched / Portal ID` to
 * `Unmatched`, told "No candidate named X in this batch" while that candidate was in the batch
 * holding that exact id. It failed in the safe direction and no assertion covered the shape, which
 * is why a 3,916-green wall said nothing about it.
 *
 * The fix is NOT to widen `normalizeCan`. Widening it changes who matches whom across imports,
 * health and certificates — that is QA-719 and it is Umesh's decision, not a side effect of this
 * unit. So: canonical key when the matcher can read the id, and the id's own exact text when it
 * cannot. The `RAW:` prefix is load-bearing — it makes the two key spaces disjoint, so an
 * unreadable id can never collide with a canonical `CAN<digits>` one.
 *
 * What this preserves and what it adds. Cycle 2 stated this as "nothing matches that did not match
 * before" and the CHECKER measured that false (QA-1251), so here is the true version:
 *   - an UNREADABLE id matches exactly as it did before this unit — byte-for-byte after trim/upper;
 *   - a READABLE one now matches across spellings, which is the fix;
 *   - and because `normalizeCan` reads the digit run and stops, a stored `CAN_41088877X` now folds
 *     onto a file's `CAN_41088877` and MATCHES, where the old raw compare kept them apart. That is a
 *     match this unit CREATES. It is deliberate and consistent — it is what the certificate matcher,
 *     the health screen and `link-portal-ids` have always done with `normalizeCan` — but it is not
 *     "nothing new", and a comment that says so would hide the one direction this change widens.
 */
export const portalIdKey = (s: unknown): string | null => {
  const canon = normalizeCan(s);
  if (canon) return canon;
  const raw = String(s ?? "").trim().toUpperCase();
  return raw ? "RAW:" + raw : null;
};

export const nameKey = (s: string | undefined) =>
  String(s ?? "").toLowerCase().replace(/\b(mr|mrs|ms|md|shri|smt|kumari)\.?\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/**
 * -153 (QA-393/QA-293): the portal rows this batch HOLDS but has not been able to attach to a
 * student yet - Ambiguous (two people share the name) or Unmatched.
 *
 * Every attendance surface reads `match_status: "Matched"`, which is correct for computing hours
 * and wrong for describing why they are missing. Measured on live -152, batch
 * AVP-GURU-RPLAVP-DST-02: both Sachin Kumars were told "the government portal export for this
 * student has not been imported (or its hours column could not be read)". The export was imported
 * three times and their hours - 63:09:00 and 60:30:00 - are stored on rows in this very
 * collection. Every clause of that sentence was false about them, while being exactly right about
 * the eight other members it was also shown to.
 *
 * Keyed by nameKey because that is the key the AMBIGUITY IS ABOUT: the matcher could not choose
 * between two members with one name, so the name is the only handle either side shares.
 * `count` carries how many unattached rows answer to the name - the ambiguity itself, said out
 * loud, so a screen can distinguish "your row is sitting there" from "two rows and nobody knows
 * which is yours".
 *
 * QA-085 is untouched by this: nothing here can qualify a student. An unattached row is evidence
 * that a NUMBER EXISTS, never evidence about whose it is.
 *
 * SCOPE, and this is the part that had to be measured rather than assumed. Only the MATCHED branch
 * of matchGovtRows sets `batch` on a row (it copies it off the member it matched); an Ambiguous row
 * gets a batch only because the import route writes `batch: r.batch ?? batchId` - i.e. only when
 * the operator filed that import AGAINST A BATCH. File the same export against the CENTRE and every
 * ambiguous row lands with batch null, and a `{ batch: batchId }` filter would quietly match
 * nothing while looking correct. That is the QA-302/QA-347 family and it is not worth re-joining.
 *
 * So the scope is the same pair matchGovtRows itself takes: this batch's rows, plus the centre's
 * rows that were never filed under any batch. A same-name student in a sibling batch at one centre
 * can pull an unresolved row into view - and that is honest, because such a row genuinely might be
 * either person's, which is what "waiting on a match" says.
 */
export async function unresolvedPortalRowsByName(scope: { batchId: unknown; locationId?: unknown }): Promise<Map<string, { count: number; hours_minutes: number | null; days_present: number | null }>> {
  const where: Record<string, unknown> = scope.locationId
    ? { $or: [{ batch: scope.batchId }, { location: scope.locationId, batch: null }] }
    : { batch: scope.batchId };
  const rows = await GovtAttendanceRow.find({ ...where, match_status: { $ne: "Matched" } })
    .select("name candidate_type designation total_hours_minutes total_days_present import createdAt")
    .sort({ createdAt: -1 })
    .lean<any[]>();
  // A RE-IMPORT SUPERSEDES, IT DOES NOT DOUBLE - the rule attendance/route.ts already keeps for
  // matched rows ("newest import per candidate wins", QA-131). Counting across imports made the
  // first version of this say "4 rows under this name" for two people in the wall fixture, which
  // imports one file three times; live, the Gurugram export has also been imported three times, so
  // the two students this was written for would have been told "6 rows". Rows are newest-first
  // above, so the FIRST import seen for a name is the newest, and only that import counts.
  const newestImportForName = new Map<string, string>();
  const byName = new Map<string, { count: number; hours_minutes: number | null; days_present: number | null }>();
  for (const r of rows) {
    // -148/QA-332: a trainer's row is the centre's own delivery record, not a student's missing
    // hours. It must never be offered as the explanation for a student having none.
    if (isTrainerRow(r)) continue;
    const nk = nameKey(r.name);
    if (!nk) continue;
    const imp = String(r.import ?? "");
    if (!newestImportForName.has(nk)) newestImportForName.set(nk, imp);
    else if (newestImportForName.get(nk) !== imp) continue; // an older import - superseded
    const prev = byName.get(nk);
    byName.set(nk, {
      count: (prev?.count ?? 0) + 1,
      hours_minutes: r.total_hours_minutes ?? prev?.hours_minutes ?? null,
      days_present: r.total_days_present ?? prev?.days_present ?? null,
    });
  }
  return byName;
}

/**
 * -155 (QA-442 groundwork / census rule): ONE definition of the shifted-column signature. The
 * import guard (-154), the portal-ID health screen and the ID-re-match all have to answer "is
 * this import trustworthy?", and three hand-typed copies of the test is exactly how the
 * catalog/dropdown/writer trio drifted (QA-424). Both halves required, deliberately: a genuinely
 * empty days-present column happens (a brand-new batch), and a file spanning two batches honestly
 * carries two working-day figures - either alone must not trip it.
 */
export function shiftSignature(rows: Array<{ total_days_present?: number | null; total_working_days?: number | null }>): {
  suspected: boolean; days_present_empty: number; distinct_working_days: number[];
} {
  const daysPresentEmpty = rows.filter((r) => r.total_days_present == null).length;
  const distinct = [...new Set(rows.map((r) => r.total_working_days).filter((v): v is number => v != null))];
  return {
    suspected: rows.length > 0 && daysPresentEmpty >= Math.ceil(rows.length * 0.9) && distinct.length > 2,
    days_present_empty: daysPresentEmpty,
    distinct_working_days: distinct,
  };
}

// -155 / QA-728: the three portal-CAN helpers moved to `lib/validate.ts`, which imports nothing and
// is therefore reachable from CLIENT components too. This file imports the mongoose models, so
// while they lived here no screen could use them - and the batch screen had already grown its own
// inline copy of the regex rather than import one. Re-exported so every existing server caller that
// imports them from `@/lib/govt-attendance` keeps working unchanged.
export { normalizeCan, looksLikeCan, storedCanIsUnreadable } from "@/lib/validate";

export type MatchStatus = "Matched" | "Ambiguous" | "Unmatched";
// -146 (QA-316): `GovtRow &` here, while matchGovtRows now honestly accepts Partial<GovtRow>[],
// would have made the compiler reject its own function's output. A matched row carries whatever the
// row it came from carried -- a parsed row has every field, a persisted document may not.
export type MatchedRow = Partial<GovtRow> & {
  candidate?: unknown; trainer?: unknown; batch?: unknown; batch_member?: unknown;
  match_status: MatchStatus; match_by: string; match_note?: string;
  internal_days_present?: number | null; variance_days?: number | null;
  // -108: set only on an UNAMBIGUOUS candidate match whose candidate has no portal ID yet. The
  // commit path writes it onto the candidate, so the certificate matcher (which joins on exactly
  // that field) stops coming up empty. Never set on an Ambiguous row.
  stamp_candidate_id?: string;
};

/**
 * Match every parsed row to an ERP candidate (or trainer), preferring the portal's own
 * candidate ID and falling back to the name. Scope is the batch when one is given, else the
 * location — never the whole database, because trainee names repeat across centres (this very
 * sample carries two "Sachin Kumar" rows).
 */
/**
 * -127 (QA-180): is this portal row one of the centre's own TRAINERS rather than a student?
 *
 * The export types its own rows — "Candidate Type" reads Trainee or Trainer — and the matcher just
 * below has always keyed off that. It is exported now because the qualification grid needs the
 * identical test: that screen used to infer "trainer" from whether the ERP had MATCHED a trainer
 * record, which is a different question and quietly wrong for a trainer the ERP has never heard of.
 * The export's own word is the answer, matched or not — one test, two callers (the QA-045 lesson).
 */
export function isTrainerRow(r: { candidate_type?: string | null; designation?: string | null }): boolean {
  return /trainer/i.test(String(r?.candidate_type ?? "")) || /trainer/i.test(String(r?.designation ?? ""));
}

// -146 (QA-316, raised by the checker against -144): this said `GovtRow[]`, where every field is
// required and every string is a string. Since -143 the import DETAIL route feeds it `.lean()`
// documents through an `as any`, so the type was describing a caller that no longer exists -- and
// `tsc --noEmit` exited 0, under strict, on the exact bare read that 500s the whole import view.
// A type that lies is worse than no type: it is why a regex over the source was standing in for the
// compiler. `Partial<GovtRow>[]` is the honest signature, and it makes tsc the guard for every
// field and every method rather than for the one field somebody remembered to scan for.
export async function matchGovtRows(
  rows: Partial<GovtRow>[],
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
    // -248 (QA-1217): was `String(...).trim().toUpperCase()`. That is a SECOND, weaker definition of
    // "is this the same portal ID", and ARCHITECTURE.md section 3 forbids exactly this: `normalizeCan`
    // is the matcher, and it reads only the digits after CAN. The raw form keyed `CAN_41088877` and
    // `CAN41088877` as two different people — both spellings pass the partial-unique index because
    // they are different strings — so a candidate stored in one spelling was invisible to a file
    // written in the other, and the row fell through to the NAME branch below. A candidate whose
    // stored id this cannot read is deliberately left out of the index rather than keyed on garbage:
    // that is `storedCanIsUnreadable`, and the screens already say so out loud.
    const canKey = portalIdKey(c.sidh_candidate_id);
    if (canKey) byGovtId.set(canKey, [...(byGovtId.get(canKey) ?? []), m]);
    const nk = nameKey(c.name);
    if (nk) byName.set(nk, [...(byName.get(nk) ?? []), m]);
  }

  // -149 (QA-334): this read `Trainer.find(scope.locationId ? {} : {})` - a ternary whose two
  // branches are the SAME empty filter, so it has always loaded every trainer in the database while
  // LOOKING like it narrowed to the import's centre. The pretence is removed; the search is global.
  //
  // -151 (QA-350): THE REASON -149 GAVE FOR LEAVING IT GLOBAL WAS WRONG, and the checker was right
  // to refuse the closure while accepting the diff. It claimed a trainer's only centre link is
  // nominated_for_location. TrainerSchema carries THREE (home_location, capable_locations,
  // nominated_for_location) and Batch.trainer is a fourth - which home/route.ts has always known,
  // since its own scope union has exactly those four arms. QA-280's "22 of 23" measured a narrower
  // predicate than the one quoted, and on a restored backup 12 of 12 trainers carry a centre link
  // through home_location while 0 of 12 carry a nomination. So "scoping would match almost nobody"
  // is false.
  //
  // The search stays global, but as an OPEN QUESTION rather than a settled one. Narrowing it means
  // reusing that same four-arm union - which is a behaviour change to matching, on live imports,
  // and -150 has just shown that three of those four arms were themselves inert until today. That
  // is a measured unit of its own, not a comment rewrite. What is true and load-bearing now: a
  // trainer row is never given a student (QA-332), and the portal ID beats the name whenever the
  // file carries one.
  const trainers = await Trainer.find({}).select("_id name govt_candidate_id").lean<any[]>();
  const trainerByName = new Map<string, any[]>();
  const trainerByGovtId = new Map<string, any>();
  for (const t of trainers) {
    const nk = nameKey(t.name);
    if (nk) trainerByName.set(nk, [...(trainerByName.get(nk) ?? []), t]);
    const tCan = portalIdKey(t.govt_candidate_id); // -248: same one key as the candidate index
    if (tCan) trainerByGovtId.set(tCan, t);
  }

  const out: MatchedRow[] = [];
  for (const r of rows) {
    // -144 (QA-314, raised by the checker against -143). This read was unguarded, and -143 is
    // what made that matter: this function used to be fed only rows fresh off the parser, where
    // `at(r, "govt_candidate_id")` always produces a string. -143 started calling it from the
    // import DETAIL route with PERSISTED documents, and a stored row without the key throws here
    // -- taking out the whole import view with a 500, not just one row's note.
    //
    // The tell was already in this function: the same expression was guarded 46 lines down, and
    // both writers in the match route use String(... ?? ""). So the value is derived ONCE, guarded,
    // and reused -- rather than patching the one line that was reported, which would have left the
    // same inconsistency for the next reader to trip over.
    const rawGid = String(r.govt_candidate_id ?? "").trim();
    // -248: `gid` is the KEY (canonical, for deciding who matches whom); `rawGid` stays the portal's
    // own spelling and is what gets displayed and stamped — a government ID is stored as issued.
    const gid = portalIdKey(rawGid);
    const nk = nameKey(r.name);
    const isTrainer = isTrainerRow(r);

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
      // Only the UNAMBIGUOUS branch stamps (the `hits.length > 1` path below never does), and the
      // caller refuses to overwrite an id that already exists — a government ID is identity data.
      const cand = hits[0].candidate;

      // -248 (QA-1218, Umesh 25/08: "candidate id ke basis par wo karna chahiye, otherwise issue
      // aata rahega"). THE SILENT ONE. A name hit onto a candidate who is ALREADY on record under a
      // DIFFERENT portal ID is not a match — it is this function overruling the two identity
      // documents in front of it with a string that repeats within every centre.
      //
      // It was silent by construction, which is why it survived: the stamp on the line below is
      // conditional on the candidate having NO id (`!cand?.sidh_candidate_id`), so in exactly this
      // case nothing is written, nothing warns, and the row stores as an ordinary `Matched` — one
      // student's hours on another student's record, indistinguishable from a correct row forever
      // after. Umesh's own Chitrakoot file is the shape that produces it: two "Sandeep Kumar" rows,
      // CAN_40829333 and CAN_40818046, where only one of the two is on the roster.
      //
      // Unconditional, and NOT part of the consent gate the import route adds: the operator can
      // reasonably consent to "I checked the register, match these by name". Nobody can consent to
      // contradicting a portal ID that is already on record — the answer is on the record already.
      // `portalIdKey` on both sides. For a READABLE id a spelling difference is never read as a
      // disagreement. For an UNREADABLE one it can be: `CAN_ED123` and `CAN ED123` are different RAW
      // keys, so one person written two ways is refused as a contradiction (QA-1250, found by the
      // checker). That fails safe — it asks a human instead of guessing — and closing it means
      // deciding what an unreadable id's equivalence class IS, which is QA-719 and Umesh's call.
      // -248 cycle 2 (QA-1226): `portalIdKey` on both sides, not `normalizeCan`. With the bare
      // matcher a candidate holding an UNREADABLE id read as "no id on record", so a file naming
      // them with a completely different readable id sailed through as a name match — the exact
      // silent mis-attribution this branch exists to stop, still open for one id shape.
      const onRecord = portalIdKey(cand?.sidh_candidate_id);
      if (by === "Name" && gid && onRecord && onRecord !== gid) {
        out.push({
          ...r, match_status: "Unmatched", match_by: "",
          match_note: `This file gives ${rawGid} for "${r.name}", but the only "${r.name}" here is on record as ${cand.sidh_candidate_id}. Two different portal IDs cannot be one person, so this row is left for you to place — click it to pick the right student, or add the candidate this ID belongs to.`,
        });
        continue;
      }

      // -108: the portal ID finally travels BACK to the candidate. This function has always READ
      // `sidh_candidate_id` to match on and never written it, which is the whole reason Manish's
      // eight correctly-named certificates all failed: the Gurugram roster carried no portal IDs,
      // so the certificate matcher's lookup was empty and every file "matched no candidate" — while
      // this very function had already worked out, by name, which candidate each CAN id belongs to.
      const stamp = gid && !cand?.sidh_candidate_id ? rawGid : undefined;
      out.push({
        ...r, candidate: cand?._id ?? hits[0].candidate, batch: hits[0].batch, batch_member: hits[0]._id,
        match_status: "Matched", match_by: by,
        ...(stamp ? { stamp_candidate_id: stamp } : {}),
      });
    } else if (hits.length > 1) {
      // -137 (G-10, 19/08 recording): this interpolated only `hits.length` and `by`, so TWO rows
      // colliding on the same name produced notes that were identical character for character — the
      // reviewer saw the same sentence printed twice under the table and could not tell which row
      // either belonged to. The row object has carried the distinguishing value all along; it just
      // was not used. The portal ID is the right one: it is what the operator has to look at to
      // decide, and it is already rendered in the PORTAL ID column beside it.
      //
      // The advice also changed. It used to say "set the portal Candidate ID on the right record",
      // which is true and sends the reader to the candidate edit drawer on another screen, reached
      // by search — while the control that actually resolves this row is the row itself.
      const which = rawGid ? `portal ID ${rawGid}` : `row ${r.sl_no ?? "?"}`;
      out.push({ ...r, match_status: "Ambiguous", match_by: by,
        match_note: `${which}: ${hits.length} candidates share this ${by.toLowerCase()} — click this row to pick the right one.` });
    } else {
      out.push({
        ...r, match_status: "Unmatched", match_by: "",
        match_note: gid ? `No candidate carries portal ID ${rawGid}.` : `No candidate named "${r.name}" in this ${scope.batchId ? "batch" : "centre"}.`,
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
// ---- QA-830 (S1, 2026-08-24, client-reported): the person who uploads cannot find their upload ----
//
// The WRITE accepted `location: null` as long as a batch was given (route.ts:98-99). The READ, for a
// scoped user, filtered on location alone - and a Trainer is ALWAYS scoped (authz.ts:83). So a row
// written that way can never match, and the two by-id routes refused it outright.
//
// Measured cost: Kamal Kumar Kushwaha, who holds both attendance.govt and closure.manage, uploaded
// the SAME 45 rows three times on 21 Aug - because after each successful upload the list said "No
// portal attendance". 135 rows sit in the database, hidden from the person who put them there.
// Admin never saw it, because Admin is not scoped.
//
// QA-125 deliberately made the by-id routes fail CLOSED here ("a centre-less import is not
// scoped-readable/deletable; before this, `imp.location &&` silently let it through") and that
// judgement was RIGHT. The defect is not the closed door - it is that the write is allowed to
// produce a record with no centre at all. So the invariant is kept exactly as QA-125 set it, and
// instead of concluding "no centre", we FIND the centre: an import's batch carries one, and
// `Batch.location` is a required field. Scope is still checked, against a real centre.
//
// One home for all three call sites (the list, the by-id load, the row-match load) because they
// disagreeing is precisely how this stayed invisible - ARCHITECTURE.md section 3.

/** The centre this import belongs to: its own, or - for rows written before -223 - its batch's. */
export async function importCentreId(imp: any): Promise<string | null> {
  const own = imp?.location?._id ?? imp?.location;
  if (own) return String(own);
  const batchId = imp?.batch?._id ?? imp?.batch;
  if (!batchId) return null;
  const b = await Batch.findById(batchId).select("location").lean<any>();
  return b?.location ? String(b.location) : null;
}

/** Is this import inside a scoped user's centres? Fails CLOSED when no centre can be found. */
export async function importInScope(scope: unknown[], imp: any): Promise<boolean> {
  const centre = await importCentreId(imp);
  if (!centre) return false;
  return scope.map(String).includes(centre);
}

/**
 * The `$or` a scoped LIST must carry. A null-location row is admitted only through a batch whose
 * centre is in scope - never a row that HAS a centre outside it, or this would widen access rather
 * than repair it.
 */
export async function scopedImportOr(scope: unknown[]): Promise<Record<string, unknown>[]> {
  const ids = (await Batch.find({ location: { $in: scope } }).select("_id").lean<any[]>()).map((b) => b._id);
  return [{ location: { $in: scope } }, { location: null, batch: { $in: ids } }];
}

/**
 * The centre a NEW import must be stored with. Derived from the batch when the file and the operator
 * gave none, so -223 onwards cannot create another unreachable record.
 */
export async function importLocationForWrite(locationId: string | null, batchId: string | null): Promise<string | null> {
  if (locationId) return locationId;
  if (!batchId) return null;
  const b = await Batch.findById(batchId).select("location").lean<any>();
  return b?.location ? String(b.location) : null;
}

export async function resolveLocationFromFile(parsed: ParsedFile) {
  if (!parsed.tc_id) return null;
  return Location.findOne({ external_id: new RegExp(`^${parsed.tc_id}$`, "i") }).select("_id name external_id").lean<any>();
}
