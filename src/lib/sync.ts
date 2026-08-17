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
  if (!mappedCols.length) throw new HttpError(400, "No field mappings configured.");

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
  if (!idCol) throw new HttpError(400, "field_mappings must map one column to external_id.");
  const colIdx = new Map(header.map((h, i) => [h, i]));

  // 2026-08-12 audit (sync S1-2): Rule 2 guarded the HEADER only. A truncated data row returned
  // undefined for its missing cells, which became "" — indistinguishable from "the client
  // cleared this field" — so a half-written row proposed wiping a location's real values. Rule 2
  // says a partial import is forbidden; that has to hold at row level too. Only mapped columns
  // matter, so a CSV that merely omits trailing unmapped cells is still read normally.
  const maxMappedIdx = Math.max(...mappedCols.map((c) => colIdx.get(c)!));
  const truncated: number[] = [];

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
    for (const col of mappedCols) {
      const field = mappings[col];
      if (field === "external_id") continue;
      const incoming = (raw[colIdx.get(col)!] ?? "").trim();
      let stored: string;
      if (field.startsWith("approved_target:")) {
        const code = field.split(":")[1];
        const program = await Program.findOne({ code }).lean<any>();
        if (!program) continue;
        const lt = loc ? await LocationTarget.findOne({ location: loc._id, program: program._id }).lean<any>() : null;
        stored = lt?.approved_target != null ? String(lt.approved_target) : "";
      } else if (LOCATION_FIELDS.has(field)) {
        stored = loc?.[field] != null ? String(loc[field]) : "";
      } else {
        continue; // Rule 1: unmapped/unknown → ignored, not stored
      }
      if (incoming === stored) continue;
      // Rule 1: only differing mapped fields become SheetChange rows.
      // Avoid duplicate Open change for same location+field+new_value.
      const dup = await SheetChange.findOne({ sync_source: src._id, location: loc?._id ?? null, field_name: field, new_value: incoming, status: "Open" });
      if (dup) continue;
      await SheetChange.create({
        sync_source: src._id,
        location: loc?._id ?? null,
        field_name: field,
        old_value: stored,
        new_value: incoming,
        impact_snapshot: loc ? await impactSnapshot(loc._id) : null, // Rule 3
      });
      created++;
    }
  }
  // Rule 2 at row level: say so plainly rather than reporting a clean run over a partial read.
  if (truncated.length) {
    src.last_status = "Partial";
    src.last_error = `${truncated.length} row(s) were missing one or more mapped columns and were skipped (row ${truncated.slice(0, 10).join(", ")}${truncated.length > 10 ? ", …" : ""}).`;
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
      if (!change.field_name.startsWith("approved_target:")) throw new HttpError(400, "Not a target change.");
      const code = change.field_name.split(":")[1];
      const program = await Program.findOne({ code });
      if (!program) throw new HttpError(400, `Program ${code} not found.`);
      // 2026-08-12 audit (sync S1-1): parseInt(new_value || "0") turned a blank cell into a
      // target of ZERO and truncated "1,200" to 1 — silently, on the number that drives how many
      // batches get planned and how many trainers get hired against a government approval.
      // A sheet cell we cannot read confidently is a question for a human, not a guess.
      const raw = String(change.new_value ?? "").trim().replace(/,/g, "");
      if (!/^\d+$/.test(raw)) {
        throw new HttpError(400,
          `Rule 4: "${change.new_value ?? ""}" is not a whole number, so the approved target was not changed. Correct the sheet cell, or set the target by hand on the location.`);
      }
      const value = Number(raw);
      await LocationTarget.findOneAndUpdate(
        { location: loc._id, program: program._id },
        { $set: { approved_target: value } },
        { upsert: true },
      );
      await audit({ entity: "LocationTarget", entityId: loc._id, field: "approved_target", oldValue: change.old_value, newValue: value, actor: actorId, actorType: "EXTERNAL_SYNC" });
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
      const allowed = !blocked.includes(change.field_name) && !change.field_name.startsWith("approved_target:")
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
export async function bulkIgnore(changeIds: string[], actorId: string) {
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
      { $set: { status: "Ignored", action_taken: "No action", actor: actorId, actioned_at: new Date() } },
    );
    // An already-applied change keeps the action it recorded; it is simply settled.
    await SheetChange.updateMany(
      { _id: { $in: ignorable }, status: "Open", action_taken: { $ne: null } },
      { $set: { status: "Ignored", actor: actorId, actioned_at: new Date() } },
    );
  }
  return { ignored: ignorable.length, skipped: blocked.size };
}
