// Sync engine — Rules 1–9 (§4 "Location and sync").
// External sheet is fetched as CSV (Google Sheet "export?format=csv" URL or any CSV endpoint).
import {
  Batch, BatchMember, Candidate, FollowUpAction, Location, LocationTarget, Program, SheetChange, SyncSource, TrainerRequest,
} from "@/models";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/authz";

const ACTIVE_BATCH_STATUSES = ["Planning", "Ready", "Active", "Closing"];

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
const LOCATION_FIELDS = new Set([
  "external_id", "name", "city", "state", "address",
  "approval_status", "spoc_name", "spoc_phone", "principal_name", "principal_phone",
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

  let text: string;
  try {
    const res = await fetch(src.source_url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    src.last_status = "Failed";
    src.last_error = e instanceof Error ? e.message : String(e);
    src.last_synced_at = new Date();
    await src.save();
    return { created: 0, status: "Failed", error: src.last_error ?? undefined };
  }

  const rows = parseCsv(text);
  if (!rows.length) {
    src.last_status = "Failed"; src.last_error = "Empty sheet"; src.last_synced_at = new Date();
    await src.save();
    return { created: 0, status: "Failed", error: "Empty sheet" };
  }
  const header = rows[0].map((h) => h.trim());
  const missing = mappedCols.filter((c) => !header.includes(c));
  if (missing.length) {
    // Rule 2: column set mismatch → stop, Partial, no changes
    src.last_status = "Partial";
    src.last_error = "Missing columns: " + missing.join(", ");
    src.last_synced_at = new Date();
    await src.save();
    return { created: 0, status: "Partial", error: src.last_error ?? undefined };
  }

  const idCol = mappedCols.find((c) => mappings[c] === "external_id");
  if (!idCol) throw new HttpError(400, "field_mappings must map one column to external_id.");
  const colIdx = new Map(header.map((h, i) => [h, i]));

  let created = 0;
  for (const raw of rows.slice(1)) {
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
      const value = parseInt(change.new_value || "0", 10);
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
    case "Put on hold":
    case "Stop location":
    case "Close location": {
      // Rule 5: sets operational_status + reason; does NOT touch batches directly
      if (!loc) throw new HttpError(400, "Change has no matched location.");
      if (!note) throw new HttpError(400, "Rule 5: a reason note is required for this action.");
      if (action === "Close location") {
        // Rule 6 is enforced via Rule 7: follow-ups must resolve before Actioned.
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
    await SheetChange.findOneAndUpdate(
      { _id: changeId, status: "Open", action_taken: { $ne: null } },
      { $set: { status: "Actioned", actioned_at: new Date() } },
    );
  }
}

// Rule 9: bulk ignore
export async function bulkIgnore(changeIds: string[], actorId: string) {
  await SheetChange.updateMany(
    { _id: { $in: changeIds }, status: "Open" },
    { $set: { status: "Ignored", action_taken: "No action", actor: actorId, actioned_at: new Date() } },
  );
}
