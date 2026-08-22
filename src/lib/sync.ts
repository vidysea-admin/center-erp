// Sync engine — Rules 1–9 (§4 "Location and sync").
// External sheet is fetched as CSV (Google Sheet "export?format=csv" URL or any CSV endpoint).
import {
  Batch, BatchMember, Candidate, FollowUpAction, Location, LocationTarget, Program, SheetChange, SyncSource, Trainer, TrainerRequest,
} from "@/models";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/authz";
import { safeFetch } from "@/lib/safe-fetch";
import * as XLSX from "xlsx";
import { fetchWorkbook, gridFromSheet, sourceAllowed, workbookIdentity } from "@/lib/workbook";
import { fieldSpec } from "@/lib/field-catalog";

const ACTIVE_BATCH_STATUSES = ["Planning", "Ready", "Active", "Closing"];

// -100 (Umesh, 17/08, "bus OneDrive wala sync karna hai, baaki sheets nahi — this is a must
// thing"): the gate every write path to `syncsources` goes through. Two refusals, both learned
// from what production actually did:
//   1. a sheet that is not the client's workbook — our own Google sheets (trainer nomination,
//      resumes, registered trainers) put THEIR rows in the review queue, which is what he saw;
//   2. the SAME workbook registered twice in the same mode — that is how one client change came
//      to be queued for review twice (37 identical rows under two names, measured 17/08).
// `existingId` is the row being edited (so a PATCH does not collide with itself).
export async function assertSyncSourceAllowed(
  data: Record<string, unknown>,
  existingId: string | null,
  existing?: { source_url?: string; mode?: string } | null,
): Promise<void> {
  const url = String(data.source_url ?? existing?.source_url ?? "");
  const mode = String(data.mode ?? existing?.mode ?? "mapped");
  const verdict = sourceAllowed(url);
  if (!verdict.ok) throw new HttpError(400, verdict.reason ?? "This sheet cannot be synced.");
  // The wall registers the real client workbook as a WATCH source in two suites on purpose (the
  // badger fetch has to be proved end to end), so watch-mode duplicates are tolerated when test
  // sources are allowed. The defect Umesh actually saw — the Sync Inbox showing every location
  // change twice — is a MAPPED duplicate, and that stays guarded everywhere, so the wall covers
  // the real bug rather than a stand-in for it.
  if (mode === "watch" && process.env.SYNC_ALLOW_TEST_SOURCES === "1") return;
  // Compare IDENTITIES, not URLs: production carried the same workbook clean and again with
  // "?rtime=…&redeem=…", and a plain string match saw two different sheets.
  const same = await SyncSource.find({ mode, ...(existingId ? { _id: { $ne: existingId } } : {}) })
    .select("name source_url mode").lean<any[]>();
  const dup = same.find((x) => workbookIdentity(String(x.source_url)) === workbookIdentity(url));
  if (dup) {
    throw new HttpError(400, `This workbook is already registered in ${mode} mode as "${dup.name}". Registering it twice queues every change for review twice — edit that one instead.`);
  }
}


// Minimal CSV parser (handles quotes and commas-in-quotes)
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Fields on Location a sheet may own. "approved_target:<PROGRAM_CODE>" targets LocationTarget.
// tc_status + tc_id + tc_password added 2026-08-13: the government's verdict AND the portal
// credentials change in the client's sheet first, and Umesh's call is that these are the initial
// credentials we are given anyway ("baad ke to hamare paas hain hi nahi"). The values are still
// masked on the review screens for anyone without locations.manage — see SENSITIVE_SYNC_COLUMNS
// in the sheet-changes route; only the mapping itself is now allowed.
const LOCATION_FIELDS = new Set([
  "external_id", "name", "city", "state", "address",
  "approval_status", "spoc_name", "spoc_phone", "principal_name", "principal_phone",
  "tc_status", "tc_id", "tc_password",
]);

// QA-497 (-166): fields that live on the (centre x job role) ROW, addressed as
// "<field>:<PROGRAM_CODE>". `approved_target` has worked this way since the first sync; the
// government's own verdict never did, and that is the whole defect.
//
// The sheet states TC Status per ROW - "31 approved hain, 10 nahi" - and each row even carries its
// own TC ID (Charthwal: TC353328 for AVPL, TC352938 for HSL). But `tc_status` was only ever in
// LOCATION_FIELDS, which is CENTRE-level, while every count in the product reads
// LocationTarget.tc_status. So the client could correct their master and the ERP would not move:
// grepping every writer of LocationTarget.tc_status returned a one-off rebase script and the manual
// PUT on the location screen, and no sync path at all. That is why the 1,000 (QA-440) had to be
// corrected by hand and would have had to be corrected by hand again.
//
// One Set, read by BOTH the diff loop and the apply switch, because two lists of "what is a row
// field" is exactly the ARCHITECTURE section 3 disease.
const TARGET_ROW_FIELDS = new Set(["approved_target", "tc_status", "tc_id"]);
export function targetRowField(field: string): { base: string; code: string } | null {
  const i = field.indexOf(":");
  if (i < 0) return null;
  const base = field.slice(0, i), code = field.slice(i + 1);
  return TARGET_ROW_FIELDS.has(base) && code ? { base, code } : null;
}

async function impactSnapshot(locationId: unknown) {
  const [batches, trainers, requests, candidates] = await Promise.all([
    Batch.countDocuments({ location: locationId, status: { $in: ACTIVE_BATCH_STATUSES } }),
    Batch.distinct("trainer", { location: locationId, status: { $in: ACTIVE_BATCH_STATUSES }, trainer: { $ne: null } }),
    TrainerRequest.countDocuments({ location: locationId, status: { $in: ["Open", "In Progress"] } }),
    Candidate.countDocuments({ location: locationId, lifecycle_status: { $in: ["Assigned", "Enrolled"] } }),
  ]);
  return { active_batches: batches, assigned_trainers: trainers.length, open_trainer_requests: requests, active_candidates: candidates, captured_at: new Date() };
}

// Rules 1 + 2: run a sync — diff mapped fields, never partial-import silently.
export async function runSync(sourceId: string): Promise<{ created: number; status: string; error?: string }> {
  const src = await SyncSource.findById(sourceId);
  if (!src) throw new HttpError(404, "Sync source not found");
  const mappings: Record<string, string> = src.field_mappings || {};
  const mappedCols = Object.keys(mappings);
  // QA-603: a refusal that throws without writing the document leaves the source row still reading
  // `last_status: "OK"` from its last clean run - and on the Daily schedule the throw is swallowed
  // into a console line, so the screen says the sync is fine while it has not run for days.
  //
  // QA-606: -189's version of this comment claimed "every other refusal in here saves first", and
  // that was simply not true - the two configuration throws below recorded nothing, and neither is
  // unreachable, because `assertSyncSourceAllowed` never validates the mappings at all. A comment
  // asserting a property the code does not have is worse than no comment: it is the reason nobody
  // looks. The helper moved up here so the claim is true by construction rather than by assertion.
  // Returns the error for the caller to `throw` rather than throwing itself: `await refuse(...)`
  // reads as a statement, so TypeScript does not treat it as terminating and every guard below it
  // lost its narrowing (`idCol` went back to `string | undefined` and the build failed). `throw
  // await refuse(...)` is terminating, and it also reads correctly - the refusal is recorded, then
  // raised.
  const refuse = async (message: string): Promise<HttpError> => {
    src.last_status = "Failed";
    src.last_error = message;
    src.last_synced_at = new Date();
    await src.save();
    return new HttpError(400, message);
  };

  if (!mappedCols.length) throw await refuse("No field mappings configured.");

  // 2026-08-13: mapped mode only understood CSV text with the header on row 1, so pasting the
  // client's OneDrive/Google-Sheets link — the thing the Admin screen invites, and exactly what
  // Manish did — could never work: those links return an xlsx binary, and the client's sheet
  // keeps a totals row ABOVE its header. Both engines now share the workbook fetcher, and the
  // header is found by looking for the mapped columns rather than assuming row 1.
  let allRows: string[][];
  try {
    if (/docs\.google\.com|drive\.google\.com|onedrive\.live\.com|1drv\.ms|sharepoint\.com|\.xlsx($|\?)/i.test(src.source_url)) {
      const wb = await fetchWorkbook(src.source_url);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      // gridFromSheet expands MERGED cells (2026-08-14) — without it the mapped sync read
      // blank institutions on continuation rows and could never track those rows' values.
      allRows = gridFromSheet(sheet).map((r) => r.map((c) => String(c ?? "")));
    } else {
      // Same SSRF guard as the watch engine — this URL is user-supplied too (2026-08-12).
      const res = await safeFetch(src.source_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      allRows = parseCsv(await res.text());
    }
  } catch (e) {
    src.last_status = "Failed";
    src.last_error = e instanceof Error ? e.message : String(e);
    src.last_synced_at = new Date();
    await src.save();
    return { created: 0, status: "Failed", error: src.last_error ?? undefined };
  }

  if (!allRows.length) {
    src.last_status = "Failed"; src.last_error = "Empty sheet"; src.last_synced_at = new Date();
    await src.save();
    return { created: 0, status: "Failed", error: "Empty sheet" };
  }

  // The header is the first row that carries every mapped column — never assumed to be row 1,
  // because the client's sheet keeps a totals row above it.
  const headerIdx = allRows.findIndex((r) => mappedCols.every((c) => r.map((h) => String(h).trim()).includes(c)));
  if (headerIdx === -1) {
    // Rule 2: column set mismatch → stop, Partial, no changes
    const probe = (allRows[0] ?? []).map((h) => String(h).trim());
    const missing = mappedCols.filter((c) => !probe.includes(c));
    src.last_status = "Partial";
    src.last_error = "Missing columns: " + missing.join(", ");
    src.last_synced_at = new Date();
    await src.save();
    return { created: 0, status: "Partial", error: src.last_error ?? undefined };
  }
  const rows = allRows.slice(headerIdx);
  const header = rows[0].map((h) => String(h).trim());

  const idCol = mappedCols.find((c) => mappings[c] === "external_id");
  if (!idCol) throw await refuse("field_mappings must map one column to external_id.");
  const colIdx = new Map(header.map((h, i) => [h, i]));

  // QA-440 / QA-497 (the half that was left): a sheet may be LONG - one row per centre x job role,
  // with a single "TC Status" column - and until now the mappings could only express WIDE, because
  // a row field had to name its programme in the mapping itself ("tc_status:PMKVYB-DSWT"). The
  // client's master is long, so mapping it at all was impossible: point that one column at one
  // programme code and BOTH of a centre's job-role rows write that programme's target, last row
  // winning, silently. That is worse than not syncing, so it was never configured, and the 1,000
  // in QA-440 had to be corrected by hand.
  //
  // A source may now map one column to `job_role`. When it does, a BARE row field ("tc_status",
  // "tc_id", "approved_target" with no ":CODE") is resolved per row from that column instead.
  // Sources that do not map it are untouched - `:CODE` still means exactly what it meant.
  const roleCol = mappedCols.find((c) => mappings[c] === "job_role");
  // The two shapes are mutually exclusive, and saying so only in the Admin help text left the
  // hazard the help text describes unenforced: on a LONG sheet a ":CODE" column resolves per
  // MAPPING rather than per row, so every one of a centre's rows writes that same programme -
  // the silent last-row-wins this change exists to prevent. A configuration error, so it is
  // refused at the start of the run rather than half-applied and explained afterwards.
  //
  // QA-602: `colIdx` is built from the header row and LAST duplicate wins (`:175`). That has always
  // been true, but until a column decided WHICH programme's target row a government verdict lands
  // on, the worst it could do was read the wrong value into the right field. Now a repeated
  // `Job role` header silently chooses the row - measured by a checker: header
  // `TC ID,Job role,Job role,TC Status` wrote against the SECOND column, never consulted the first,
  // and reported a clean OK.
  //
  // We cannot know which of two identically-named columns was meant, and this file's own standard
  // for that is written a few lines down: "A sheet cell we cannot read confidently is a question
  // for a human, not a guess." So any DUPLICATED mapped header refuses the run and names itself.
  // Scoped to mapped columns on purpose: an unmapped duplicate is none of our business.
  const dupHeaders = mappedCols.filter((c) => header.filter((h) => h === c).length > 1);
  if (dupHeaders.length) {
    throw await refuse(`The sheet has more than one column headed ${dupHeaders.map((c) => `"${c}"`).join(", ")}, and that column is mapped, so there is no way to tell which one this source means. Rename or remove the duplicate; a value read from the wrong column of two with the same name is worse than no sync.`);
  }

  if (roleCol) {
    const coded = mappedCols.filter((c) => targetRowField(mappings[c]));
    if (coded.length) {
      throw await refuse(`This source maps "${roleCol}" to job_role, so its rows are one per centre and job role. Column(s) ${coded.map((c) => `"${c}"`).join(", ")} still name a programme (${coded.map((c) => mappings[c]).join(", ")}), which would write that one programme for every row of a centre. Drop the ":CODE" suffix from them, or remove the job_role mapping.`);
    }
  }
  // Resolve WITHIN THE TC ID'S OWN TARGET ROWS, never by programme name alone: measured on live
  // 2026-08-22, two programmes carry the identical name "Drone Service Technician" (RPLAVP-DST and
  // PMKVYB-DST) and differ only by scheme. The TC ID already pins the scheme - the government
  // registers each (centre x scheme x job role) separately - so inside one TC ID a job-role name
  // appears once. Live: 55 target rows, 48 carrying a tc_id, 35 distinct ids, and zero duplicate
  // (tc_id + job role) pairs among them.
  const unresolvedRoles: string[] = [];

  // 2026-08-12 audit (sync S1-2): Rule 2 guarded the HEADER only. A truncated data row returned
  // undefined for its missing cells, which became "" — indistinguishable from "the client
  // cleared this field" — so a half-written row proposed wiping a location's real values. Rule 2
  // says a partial import is forbidden; that has to hold at row level too. Only mapped columns
  // matter, so a CSV that merely omits trailing unmapped cells is still read normally.
  const maxMappedIdx = Math.max(...mappedCols.map((c) => colIdx.get(c)!));
  const truncated: number[] = [];
  // QA-520: registration numbers that more than one CENTRE claims. Never resolved by write
  // order - reported, like a truncated row, so a partial read never reads as a clean one.
  const ambiguous: string[] = [];

  let created = 0;
  for (const [rowNo, raw] of rows.slice(1).entries()) {
    if (raw.length <= maxMappedIdx) {
      // A row that does not physically carry every mapped column is unreadable, not empty.
      if (raw.some((cell) => String(cell ?? "").trim())) truncated.push(rowNo + 2); // 1-based, +header
      continue;
    }
    const externalId = (raw[colIdx.get(idCol)!] ?? "").trim();
    if (!externalId) continue;
    const loc = await Location.findOne({ external_id: externalId }).lean<any>();
    // QA-520 (-169): the sheet's row identity is its OWN TC ID, and a centre has SEVERAL - the
    // government registers each (centre x scheme x job role) separately and numbers each one
    // (Charthwal: TC353328 for AVPL, TC352938 for HSL). `Location.external_id` can hold exactly
    // one of them, so on live 20 of the sheet's 35 TC IDs reached NO location at all - including
    // four of the five rows QA-440 exists for. Those rows could not be corrected from the sheet,
    // ever, and the sync reported a clean run while ignoring them.
    //
    // So a row-level field asks WHICH CENTRE carries this number. It is the centre the number
    // identifies, not the job role: `propose-tc-ids.mjs:96` says it in one line - "A TC ID
    // repeats across job-role rows" - and live agrees, 35 distinct TC IDs against 55 target rows.
    // The job role still comes from the mapping's :CODE, exactly as before.
    const anchors = await LocationTarget.find({ tc_id: externalId }).select("location").lean<any[]>();
    const anchorLocs = [...new Set(anchors.map((a) => String(a.location)))];
    // ONE number pointing at TWO centres is not something to settle by write order - it is a
    // question, and the same standard the -163 move door holds. Refuse the whole row and say so.
    if (anchorLocs.length > 1) {
      ambiguous.push(`${externalId} (${anchorLocs.length} different centres carry it)`);
      continue;
    }
    const anchorLoc = anchorLocs.length === 1 ? anchors[0].location : null;

    // QA-440: which job role is THIS row about? Answered from the target rows this TC ID carries,
    // so the scheme comes along for free. Nothing is guessed - a name that matches none of them, or
    // more than one, makes the row a question and it is reported, not written.
    let rowCode: string | null = null;
    if (roleCol) {
      const roleText = (raw[colIdx.get(roleCol)!] ?? "").trim();
      // A BLANK job-role cell is not "nothing to do" - it is a row that cannot be addressed, and
      // the first version of this guarded resolution with `if (roleText)`, so a blank pushed
      // nothing, resolved to nothing, and every per-job-role field on the row was dropped while
      // the run still reported OK. That is the precise shape this whole change exists to kill
      // ("both halves of the client's problem sat behind last_status: OK for weeks"), rebuilt in
      // the lines written to kill it. A blank is now as loud as a wrong name.
      if (!roleText) {
        unresolvedRoles.push(`${externalId} / (the job-role cell is blank)`);
      } else {
        const own = await LocationTarget.find({ tc_id: externalId }).populate("program", "code name").lean<any[]>();
        const hits = own.filter((r) => String(r.program?.name ?? "").trim().toLowerCase() === roleText.toLowerCase());
        const codes = [...new Set(hits.map((h) => String(h.program?.code ?? "")).filter(Boolean))];
        if (codes.length === 1) rowCode = codes[0];
        else unresolvedRoles.push(`${externalId} / "${roleText}"${codes.length > 1 ? ` (${codes.length} programmes match)` : " (no target row for that job role)"}`);
      }
    }

    for (const col of mappedCols) {
      const field = mappings[col];
      if (field === "external_id" || field === "job_role") continue;
      const incoming = (raw[colIdx.get(col)!] ?? "").trim();
      let stored: string;
      // A bare row field on a job_role-mapped source resolves per row. If the row's job role could
      // not be resolved, the field is SKIPPED rather than falling through to LOCATION_FIELDS -
      // that fall-through is exactly the centre-level write this change exists to stop.
      //
      // Note what is NOT skipped, because the first wording of the Partial message said "rows were
      // skipped" and that was not true: this `continue` sits inside the per-COLUMN loop, so the
      // row's CENTRE-level fields (name, city, spoc, ...) are still written. That is correct - the
      // centre is known, only the job role is not - and it is a deliberate difference from the
      // ambiguous-TC-ID path above, which abandons the whole row because the CENTRE itself is in
      // doubt. The message now says which of the two happened.
      const bareRowField = !!roleCol && !field.includes(":") && TARGET_ROW_FIELDS.has(field);
      if (bareRowField && !rowCode) continue;
      const rowField = targetRowField(field) ?? (bareRowField ? { base: field, code: rowCode! } : null);
      if (rowField) {
        const program = await Program.findOne({ code: rowField.code }).lean<any>();
        if (!program) continue;
        // QA-520: the centre comes from whoever carries this registration number, and only falls
        // back to the sheet key when nobody does. That fallback is what keeps every source that
        // has always keyed on a centre working exactly as it did.
        const ltLoc = anchorLoc ?? loc?._id ?? null;
        const lt = ltLoc ? await LocationTarget.findOne({ location: ltLoc, program: program._id }).lean<any>() : null;
        // A BLANK stored value has to compare as blank, not as "0" or "undefined" - the five rows
        // in QA-440 are blank in the sheet and Approved in the ERP, and a diff that cannot see
        // blank-vs-value is a diff that cannot report them.
        stored = (lt as any)?.[rowField.base] != null ? String((lt as any)[rowField.base]) : "";
      } else if (LOCATION_FIELDS.has(field)) {
        stored = loc?.[field] != null ? String(loc[field]) : "";
      } else {
        continue; // Rule 1: unmapped/unknown → ignored, not stored
      }
      if (incoming === stored) continue;
      // Rule 1: only differing mapped fields become SheetChange rows.
      // -111 (Umesh 18/08: "user ne jin pe action le liya, wo wapas nahi aane chahiye"): the
      // duplicate check used to look at OPEN rows only. The moment a user Actioned or Ignored a
      // change, the same standing difference stopped counting as a duplicate — and the next tick
      // recreated it. A decision the user has already made is a decision, not a fresh diff, so a
      // matching row in ANY status suppresses re-creation. It only comes back if the sheet
      // actually changes to a NEW value.
      // QA-520: a row-level change belongs to the centre that carries the number; everything else
      // keeps the sheet key's centre. Same value used for the duplicate check and the write, or a
      // re-run would raise a second row for the same fact.
      const changeLoc = (rowField ? anchorLoc : null) ?? loc?._id ?? null;
      // QA-440: a per-row change is STORED in the canonical "<base>:<CODE>" form even when the
      // mapping wrote it bare. That is deliberate and it is what keeps this change to one function:
      // the apply switch (targetRowField), the Apply-value guard, and the revert route's
      // `startsWith("approved_target:")` all read this string, and all three keep working untouched.
      // Same value for the duplicate check and the write, or a re-run raises a second row.
      const storedField = rowField ? `${rowField.base}:${rowField.code}` : field;
      const dup = await SheetChange.findOne({ sync_source: src._id, location: changeLoc, field_name: storedField, new_value: incoming, status: { $in: ["Open", "Actioned", "Ignored"] } });
      if (dup) continue;
      await SheetChange.create({
        sync_source: src._id,
        location: changeLoc,
        field_name: storedField,
        old_value: stored,
        new_value: incoming,
        impact_snapshot: loc ? await impactSnapshot(loc._id) : null, // Rule 3
      });
      created++;
    }
  }
  // THREE reasons a run is not clean, and each one used to be its own early return, so a sheet
  // with more than one fault reported only the first and the rest vanished - on precisely the
  // signal whose whole job is to say the run was not clean.
  //
  // QA-604: -188 merged two of the three and left `ambiguous` in front of both, which fixed the
  // symptom for one pair and kept it for every pair involving the first. Merging two of three is
  // the same defect wearing a smaller coat. All three now report together.
  const partialReasons: string[] = [];
  // QA-520: a run that skipped rows because their registration number is claimed twice is NOT a
  // clean run, and reporting it as one is how the last of these stayed invisible for a month.
  if (ambiguous.length) {
    partialReasons.push(`${ambiguous.length} TC ID(s) are carried by more than one centre, so those sheet rows were skipped entirely rather than guessed: ${ambiguous.slice(0, 5).join("; ")}${ambiguous.length > 5 ? "; …" : ""}. One government registration number belongs to one centre — correct it on the location screen.`);
  }
  // QA-440: the same standard as the ambiguous TC IDs above. A row whose job role matched no target
  // row - or matched more than one - was NOT written, and a run that skipped rows is not a clean
  // run. Both halves of the client's problem were invisible for weeks behind a `last_status: OK`,
  // so silence here would rebuild the exact thing being fixed.
  if (unresolvedRoles.length) {
    partialReasons.push(`${unresolvedRoles.length} row(s) named a job role that could not be matched to a target row, so THAT ROW'S PER-JOB-ROLE FIELDS were skipped rather than guessed (the row's centre-level fields were still read): ${unresolvedRoles.slice(0, 5).join("; ")}${unresolvedRoles.length > 5 ? "; …" : ""}. Set that job role's approved target on the centre first, or correct the job role in the sheet.`);
  }
  // Rule 2 at row level: say so plainly rather than reporting a clean run over a partial read.
  if (truncated.length) {
    partialReasons.push(`${truncated.length} row(s) were missing one or more mapped columns and were skipped entirely (row ${truncated.slice(0, 10).join(", ")}${truncated.length > 10 ? ", …" : ""}).`);
  }
  if (partialReasons.length) {
    src.last_status = "Partial";
    src.last_error = partialReasons.join(" ");
    src.last_synced_at = new Date();
    await src.save();
    return { created, status: "Partial", error: src.last_error };
  }
  src.last_status = "OK"; src.last_error = undefined; src.last_synced_at = new Date();
  await src.save();
  return { created, status: "OK" };
}

// Rule 8: generate follow-ups for Stop/Close. Each must land with an owner —
// the location's SPOC user when linked, otherwise the Admin/Ops actor who applied
// the action — and a due date, so nothing sits unowned in the queue.
async function generateFollowUps(changeId: unknown, location: any, actorId: string) {
  const locationId = location._id;
  const owner = location.spoc_user ?? actorId;
  const due_date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const base = { source_change: changeId, owner, due_date };
  const batches = await Batch.find({ location: locationId, status: { $in: ACTIVE_BATCH_STATUSES } }).lean<any[]>();
  const fups: any[] = [];
  for (const b of batches) {
    fups.push({ ...base, type: "Stop batch", target_entity: "Batch", target_id: b._id });
    if (b.trainer) fups.push({ ...base, type: "Release trainer", target_entity: "Trainer", target_id: b.trainer });
    const members = await BatchMember.countDocuments({ batch: b._id, left_on: null });
    if (members > 0) fups.push({ ...base, type: "Return candidates to pool", target_entity: "Batch", target_id: b._id });
  }
  const requests = await TrainerRequest.find({ location: locationId, status: { $in: ["Open", "In Progress"] } }).lean<any[]>();
  for (const r of requests) {
    fups.push({ ...base, type: "Cancel trainer request", target_entity: "TrainerRequest", target_id: r._id });
  }
  if (fups.length) await FollowUpAction.insertMany(fups);
  return fups.length;
}

// Rules 4–8: apply an action on a SheetChange
export async function applySheetChange(changeId: string, action: string, note: string | undefined, actorId: string) {
  const change = await SheetChange.findById(changeId);
  if (!change) throw new HttpError(404, "Change not found");
  if (change.status !== "Open") throw new HttpError(409, "Change already handled.");
  const loc = change.location ? await Location.findById(change.location) : null;

  let followUps = 0;
  switch (action) {
    case "No action":
      change.status = "Ignored"; // Rule 9 semantics for single ignore
      break;
    case "Update target": {
      // Rule 4: writes approved_target only; never edits batches
      if (!loc) throw new HttpError(400, "Change has no matched location.");
      const rowField = targetRowField(change.field_name);
      if (!rowField) throw new HttpError(400, "Not a target-row change.");
      const program = await Program.findOne({ code: rowField.code });
      if (!program) throw new HttpError(400, `Program ${rowField.code} not found.`);
      // 2026-08-12 audit (sync S1-1): parseInt(new_value || "0") turned a blank cell into a
      // target of ZERO and truncated "1,200" to 1 — silently, on the number that drives how many
      // batches get planned and how many trainers get hired against a government approval.
      // A sheet cell we cannot read confidently is a question for a human, not a guess.
      let value: string | number;
      if (rowField.base === "approved_target") {
        // 2026-08-12 audit (sync S1-1): parseInt(new_value || "0") turned a blank cell into a
        // target of ZERO and truncated "1,200" to 1 - silently, on the number that drives how many
        // batches get planned. A cell we cannot read confidently is a question for a human.
        const raw = String(change.new_value ?? "").trim().replace(/,/g, "");
        if (!/^\d+$/.test(raw)) {
          throw new HttpError(400,
            `"${change.new_value ?? ""}" is not a whole number, so the approved target was not changed. Correct the sheet cell, or set the target by hand on the location.`);
        }
        value = Number(raw);
      } else {
        // QA-497: tc_status and tc_id are free text FROM THE SHEET and the schema says so
        // ("free text from the sheet (\"Approved\", blank, ...)"). A BLANK is a real value here,
        // not a missing one - the five rows in QA-440 are blank in the client's master and
        // Approved in the ERP, and refusing blank would make the sheet unable to say so. No
        // vocabulary is enforced: inventing one would silently reinterpret the government's own
        // words, and the third state Karunn sir described at 12:31 is still undecided (REQ-365c).
        value = String(change.new_value ?? "").trim();
      }
      // `upsert` stays for approved_target (a target row is created by its target) but a status or
      // an id must never CONJURE a row: a government verdict for a job role this centre has no
      // target on is a question, not a write.
      const existing = await LocationTarget.findOne({ location: loc._id, program: program._id });
      if (!existing && rowField.base !== "approved_target") {
        throw new HttpError(409,
          `${loc.name} has no target row for ${program.name}, so there is nothing to mark "${value}". Set that job role's approved target first - a status cannot create the row it describes.`);
      }
      await LocationTarget.findOneAndUpdate(
        { location: loc._id, program: program._id },
        { $set: { [rowField.base]: value } },
        { upsert: rowField.base === "approved_target" },
      );
      await audit({ entity: "LocationTarget", entityId: loc._id, field: `${rowField.base} (${program.code})`, oldValue: change.old_value, newValue: String(value), actor: actorId, actorType: "EXTERNAL_SYNC" });
      break;
    }
    case "Start location": {
      if (!loc) throw new HttpError(400, "Change has no matched location.");
      loc.operational_status = "Active";
      loc.status_changed_on = new Date();
      if (change.field_name === "approval_status") loc.approval_status = (change.new_value as any) || loc.approval_status;
      await loc.save();
      break;
    }
    case "Apply value": {
      // 2026-08-13: the generic "write what the sheet says" action. Before this, a detected
      // change on spoc_phone or a trainer's qualification had no action that wrote it — it could
      // only be Ignored. A human clicking Apply IS the review; the write is audited and
      // revertible (see /api/sheet-changes/[id]/revert).
      const entityType = (change.entity_type as "Location" | "Trainer" | "Candidate") ?? "Location";
      const Model = entityType === "Trainer" ? Trainer : entityType === "Candidate" ? Candidate : Location;
      const targetId = change.entity ?? (entityType === "Location" ? change.location : null);
      if (!targetId) throw new HttpError(400, "Change has no matched record to write to.");
      // field_name is sheet data, not a free property path — only catalog/mapping fields may be
      // written, and status fields must go through their own guarded actions above.
      const blocked = ["approval_status", "operational_status", "pipeline_status", "lifecycle_status"];
      const allowed = !blocked.includes(change.field_name) && !targetRowField(change.field_name)
        && (entityType === "Location" ? LOCATION_FIELDS.has(change.field_name) : !!fieldSpec(entityType, change.field_name));
      if (!allowed) throw new HttpError(400, `"${change.field_name}" cannot be written by Apply value — use the specific action for it.`);
      const doc = await Model.findById(targetId);
      if (!doc) throw new HttpError(404, `${entityType} not found.`);
      const snap = change.impact_snapshot as any;
      const resolved = snap && snap.apply !== undefined ? snap.apply : change.new_value;
      doc.set(change.field_name, resolved === "" ? undefined : resolved);
      await doc.save({ validateModifiedOnly: true });
      await audit({ entity: entityType, entityId: doc._id, field: change.field_name, oldValue: change.old_value, newValue: change.new_value, actor: actorId, actorType: "EXTERNAL_SYNC" });
      break;
    }
    case "Put on hold":
    case "Stop location":
    case "Close location": {
      // Rule 5: sets operational_status + reason; does NOT touch batches directly
      if (!loc) throw new HttpError(400, "Change has no matched location.");
      if (!note) throw new HttpError(400, "Rule 5: a reason note is required for this action.");
      if (action === "Close location") {
        // 2026-08-12 audit (sync S1-3): Rule 6 says Close "cannot be applied while the location
        // has any batch in Active or Closing status UNTIL the generated FollowUpActions are
        // resolved or explicitly skipped". The close used to land immediately, and the Rule 1
        // "location must be operational" guard then locked the still-running batch out of its
        // own daily logs — attendance mid-delivery simply could not be recorded.
        //
        // Refusing the action outright would be just as wrong: the follow-ups are generated BY
        // applying it, so a refusal makes the rule unsatisfiable. The close is therefore
        // DEFERRED — follow-ups are raised now, the centre keeps operating so its batches can
        // still be logged, and settleChangeIfDone() closes it once the last one is settled.
        const live = await Batch.countDocuments({ location: loc._id, status: { $in: ["Active", "Closing"] } });
        if (live > 0) {
          loc.status_reason = note;
          loc.status_changed_on = new Date();
          await loc.save();
          followUps = await generateFollowUps(change._id, loc, actorId); // Rule 8
          change.action_taken = action as any;
          change.note = note;
          change.actor = actorId as any;
          change.status = "Open"; // Rule 7: settles — and closes the location — when they resolve
          await change.save();
          return { change, followUps, deferred: true };
        }
        loc.operational_status = "Closed";
      } else if (action === "Stop location") {
        loc.operational_status = "Stopped";
      } else {
        loc.operational_status = "On Hold";
      }
      loc.status_reason = note;
      loc.status_changed_on = new Date();
      await loc.save();
      if (action !== "Put on hold") {
        followUps = await generateFollowUps(change._id, loc, actorId); // Rule 8
      }
      break;
    }
    default:
      throw new HttpError(400, "Unknown action: " + action);
  }

  change.action_taken = action as any;
  change.note = note;
  change.actor = actorId as any;

  if (action !== "No action") {
    const pending = await FollowUpAction.countDocuments({ source_change: change._id, status: "Pending" });
    if (pending > 0) {
      change.status = "Open"; // Rule 7: cannot be Actioned while follow-ups pending
    } else {
      change.status = "Actioned";
      change.actioned_at = new Date();
    }
  }
  await change.save();
  if (loc) await audit({ entity: "Location", entityId: loc._id, field: "sheet_change_action", oldValue: change.old_value, newValue: `${action}: ${change.new_value}`, actor: actorId, actorType: "EXTERNAL_SYNC" });
  return { change, followUps };
}

// Called when a follow-up completes: if none pending, action the parent change (Rule 7).
export async function settleChangeIfDone(changeId: unknown) {
  const pending = await FollowUpAction.countDocuments({ source_change: changeId, status: "Pending" });
  if (pending === 0) {
    const settled = await SheetChange.findOneAndUpdate(
      { _id: changeId, status: "Open", action_taken: { $ne: null } },
      { $set: { status: "Actioned", actioned_at: new Date() } },
      { new: false },
    );
    // Rule 6 (sync S1-3): a Close held back because batches were still running lands here, once
    // every follow-up it raised has been "resolved or explicitly skipped" — which is the human
    // saying they have dealt with it. We take them at their word and close now; deciding for
    // them by re-inspecting batch status would make a skipped follow-up impossible to get past.
    if (settled?.action_taken === "Close location" && settled.location) {
      await Location.findByIdAndUpdate(settled.location, {
        $set: { operational_status: "Closed", status_changed_on: new Date() },
      });
    }
  }
}

// Rule 9: bulk ignore
// -111: `note` rides along so an archive is self-describing on the row ("pre-wipe baseline, archived
// 18/08 — start from zero") rather than a mystery Ignore.
export async function bulkIgnore(changeIds: string[], actorId: string, note?: string) {
  // 2026-08-12 audit (sync S1-8): this closed out every selected change unconditionally, so a
  // change that had already been Applied and was sitting Open only because its follow-ups were
  // still Pending (Rule 7's whole purpose) could be swept away through the Ignore door — and
  // action_taken was overwritten to "No action", erasing the record of what had actually been
  // done. Rule 7 is about outstanding work, not about which button was pressed.
  const withPending = await FollowUpAction.distinct("source_change", {
    source_change: { $in: changeIds }, status: "Pending",
  });
  const blocked = new Set(withPending.map(String));
  const ignorable = changeIds.filter((id) => !blocked.has(String(id)));

  if (ignorable.length) {
    await SheetChange.updateMany(
      // Only a change nobody has acted on yet becomes a plain "No action" ignore.
      { _id: { $in: ignorable }, status: "Open", action_taken: null },
      { $set: { status: "Ignored", action_taken: "No action", actor: actorId, actioned_at: new Date(), ...(note ? { note } : {}) } },
    );
    // An already-applied change keeps the action it recorded; it is simply settled.
    await SheetChange.updateMany(
      { _id: { $in: ignorable }, status: "Open", action_taken: { $ne: null } },
      { $set: { status: "Ignored", actor: actorId, actioned_at: new Date(), ...(note ? { note } : {}) } },
    );
  }
  return { ignored: ignorable.length, skipped: blocked.size };
}
