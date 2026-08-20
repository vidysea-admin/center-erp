import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, locationFilter, HttpError } from "@/lib/authz";
import { requirePerm, requireView } from "@/lib/permissions";
import { BatchMember, Candidate, GovtAttendanceImport, GovtAttendanceRow } from "@/models";
import { normalizeCan, shiftSignature } from "@/lib/govt-attendance";
import { audit } from "@/lib/audit";

// -155 (QA-427, and the door for QA-414's recovery): the portal-ID health screen.
//
// Umesh: "popup ya preview me aana chahiye properly, jahan wo fix kar sake, aur SELECTED walo ka
// fix kar paaye." Measured on live before this existed: 55 candidates carried a CAN-shaped value
// in id_reference while sidh_candidate_id - the field BOTH government matchers join on - sat
// empty, and nothing surfaced it until a qualified count read 25 where the client counted 27.
//
// Same contract as link-portal-ids (-108), because it is the same problem one level up:
//   GET  -> the plan. Writes NOTHING. It is also the read-only precondition check for the QA-417
//           unique index (duplicates + empty strings), which is why it exists as a door and not a
//           one-off script: this data WILL go wrong again, and the person who finds it next time
//           should not need an engineer.
//   POST -> applies ONLY the ids the operator selected, one audit row per write, never overwrites
//           an existing value, refuses a disagreeing row rather than resolving it by luck.
//
// The findings are NOT equally fixable, and the shape of the payload says so:
//   empty_strings   -> mechanical ("" is an artefact, not an identity)     - selectable
//   misfiled        -> copy id_reference -> sidh_candidate_id (REQ-381)    - selectable
//   rematchable     -> attach an unattached row by EXACT ID equality       - selectable
//   disagreements   -> a human must look; the machine never chooses        - report only
//   duplicates      -> one government identity, two people; human decides  - report only
//   enrolled_no_can -> the government issues the ID; we cannot invent it   - report only

const CAN_SHAPE = /CAN/i;

async function plan(user: Awaited<ReturnType<typeof requireUser>>) {
  const scope = locationFilter(user);

  // a) "" artefacts - would collide under the QA-417 partial unique index ("" IS a string).
  const emptyStrings = await Candidate.find({ sidh_candidate_id: "", ...scope })
    .select("name phone").lean<any[]>();

  // b+c) CAN-shaped values sitting in id_reference (the field the model itself says is "NOT the
  // Aadhaar number itself" and was never meant to hold a portal CAN).
  const withRef = await Candidate.find({ id_reference: CAN_SHAPE, ...scope })
    .select("name phone id_reference sidh_candidate_id").lean<any[]>();
  const misfiled = withRef.filter((c) => normalizeCan(c.id_reference) && !c.sidh_candidate_id)
    .map((c) => ({ candidate: c._id, name: c.name, phone: c.phone ?? null, can: String(c.id_reference).trim() }));
  const disagreements = withRef.filter((c) => {
    const ref = normalizeCan(c.id_reference);
    return ref && c.sidh_candidate_id && normalizeCan(c.sidh_candidate_id) !== ref;
  }).map((c) => ({ candidate: c._id, name: c.name, phone: c.phone ?? null, on_record: c.sidh_candidate_id, in_id_reference: c.id_reference }));

  // d) one portal identity on two people. The unique index stops a THIRD from being written; it
  // cannot arbitrate the two that already exist - only a human can say whose it is.
  const dupRows = await Candidate.aggregate([
    { $match: { sidh_candidate_id: { $type: "string", $ne: "" }, ...scope } },
    { $group: { _id: "$sidh_candidate_id", n: { $sum: 1 }, members: { $push: { candidate: "$_id", name: "$name", phone: "$phone" } } } },
    { $match: { n: { $gt: 1 } } },
  ]);

  // e) unattached rows whose CAN matches EXACTLY ONE candidate - attachable by ID equality, which
  // is not a guess (QA-085 intact: identity decides, never the name). Rows from an import whose
  // rows carry the -154 shift signature are excluded: a corrupt file's row must not become
  // anybody's newest figure through this door.
  const canOwners = new Map<string, any[]>();
  for (const c of await Candidate.find({ sidh_candidate_id: { $type: "string", $ne: "" }, ...scope })
    .select("name sidh_candidate_id").lean<any[]>()) {
    const can = normalizeCan(c.sidh_candidate_id);
    if (can) canOwners.set(can, [...(canOwners.get(can) ?? []), c]);
  }
  const unattached = await GovtAttendanceRow.find({ match_status: { $ne: "Matched" }, govt_candidate_id: CAN_SHAPE, ...locationFilter(user, "location") })
    .select("name govt_candidate_id import batch location total_hours_raw").lean<any[]>();
  const importIds = [...new Set(unattached.map((r) => String(r.import)))];
  const suspectImports = new Set<string>();
  for (const impId of importIds) {
    const rows = await GovtAttendanceRow.find({ import: impId })
      .select("total_days_present total_working_days").lean<any[]>();
    if (shiftSignature(rows).suspected) suspectImports.add(impId);
  }
  const imports = await GovtAttendanceImport.find({ _id: { $in: importIds } })
    .select("period_label file_name").lean<any[]>();
  const impById = new Map(imports.map((i) => [String(i._id), i]));
  const rematchable: any[] = [];
  const skippedSuspectImport: any[] = [];
  for (const r of unattached) {
    const can = normalizeCan(r.govt_candidate_id);
    if (!can) continue;
    const owners = canOwners.get(can) ?? [];
    if (owners.length !== 1) continue; // zero owners = nothing to attach to; two = duplicates above
    const entry = {
      row: r._id, name: r.name, can: String(r.govt_candidate_id).trim(),
      candidate: owners[0]._id, candidate_name: owners[0].name,
      from: impById.get(String(r.import))?.period_label || impById.get(String(r.import))?.file_name || "an import",
      hours_raw: r.total_hours_raw ?? null,
    };
    if (suspectImports.has(String(r.import))) skippedSuspectImport.push(entry);
    else rematchable.push(entry);
  }

  // f) enrolled with no CAN anywhere - the list Manish sir needs, not a write.
  const enrolled = await BatchMember.find({ left_on: null, enrollment_status: "Completed" })
    .populate("candidate", "name phone sidh_candidate_id id_reference")
    .populate("batch", "code location").lean<any[]>();
  const enrolledNoCan = enrolled.filter((m) => {
    if (!m.candidate) return false;
    if (normalizeCan(m.candidate.sidh_candidate_id)) return false;
    if (normalizeCan(m.candidate.id_reference)) return false; // those are "misfiled", above
    return true;
  }).map((m) => ({ candidate: m.candidate._id, name: m.candidate.name, phone: m.candidate.phone ?? null, batch: m.batch?.code ?? null }));

  return {
    empty_strings: emptyStrings.map((c) => ({ candidate: c._id, name: c.name, phone: c.phone ?? null })),
    misfiled,
    disagreements,
    duplicates: dupRows.map((d) => ({ id: d._id, members: d.members })),
    rematchable,
    skipped_suspect_import: skippedSuspectImport,
    enrolled_no_can: enrolledNoCan,
  };
}

export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "candidates.manage");
  return NextResponse.json(await plan(user));
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.manage");
  const body = await req.json().catch(() => ({}));
  const pick = (k: string) => Array.isArray(body[k]) ? body[k].map(String) : [];
  const setNull = pick("set_null"), copy = pick("copy"), rematch = pick("rematch");
  if (!setNull.length && !copy.length && !rematch.length) {
    throw new HttpError(400, "Select at least one row to fix — nothing is applied wholesale.");
  }
  // The plan is recomputed at write time: the screen's list may be minutes old, and every guard
  // below re-verifies against the database as it is NOW, not as it was rendered.
  const p = await plan(user);
  const results = { set_null: 0, copied: 0, rematched: 0, refused: [] as string[] };

  const inPlan = (list: any[], key: string, id: string) => list.find((x) => String(x[key]) === id);

  for (const id of setNull) {
    if (!inPlan(p.empty_strings, "candidate", id)) { results.refused.push(`set_null ${id}: no longer an empty-string artefact`); continue; }
    await Candidate.updateOne({ _id: id, sidh_candidate_id: "" }, { $set: { sidh_candidate_id: null } });
    await audit({ entity: "Candidate", entityId: id, field: "sidh_candidate_id", oldValue: '"" (empty-string artefact)', newValue: "null", actor: user.id });
    results.set_null++;
  }

  for (const id of copy) {
    const m = inPlan(p.misfiled, "candidate", id);
    if (!m) { results.refused.push(`copy ${id}: no longer a clean misfiled row (value set meanwhile, or it disagrees)`); continue; }
    // never overwrite; the filter carries the emptiness check so a concurrent write loses safely
    const res = await Candidate.updateOne(
      { _id: id, $or: [{ sidh_candidate_id: null }, { sidh_candidate_id: "" }, { sidh_candidate_id: { $exists: false } }] },
      { $set: { sidh_candidate_id: m.can } },
    );
    if (!res.modifiedCount) { results.refused.push(`copy ${id}: a value appeared since the plan was read — left untouched`); continue; }
    await audit({ entity: "Candidate", entityId: id, field: "sidh_candidate_id", oldValue: "", newValue: `${m.can} (copied from id_reference by the Portal ID health screen)`, actor: user.id });
    results.copied++;
  }

  for (const id of rematch) {
    const r = inPlan(p.rematchable, "row", id);
    if (!r) { results.refused.push(`rematch ${id}: row no longer attachable by exact ID (resolved meanwhile, owner count changed, or its import is shift-suspected)`); continue; }
    const row = await GovtAttendanceRow.findById(id).select("batch candidate match_status").lean<any>();
    if (!row || row.match_status === "Matched") { results.refused.push(`rematch ${id}: already matched`); continue; }
    const member = await BatchMember.findOne({ candidate: r.candidate, ...(row.batch ? { batch: row.batch } : { left_on: null }) })
      .select("_id batch").lean<any>();
    await GovtAttendanceRow.updateOne({ _id: id, match_status: { $ne: "Matched" } }, {
      $set: {
        candidate: r.candidate, batch_member: member?._id ?? null, batch: row.batch ?? member?.batch ?? null,
        match_status: "Matched", match_by: "Portal ID (re-match)",
        match_note: `attached by exact portal-ID equality (${r.can}) after the ID was recovered — never by name`,
      },
    });
    await audit({
      entity: "GovtAttendanceImport", entityId: String((await GovtAttendanceRow.findById(id).select("import").lean<any>())?.import ?? id),
      field: "match", oldValue: `row ${id} unmatched`, newValue: `row ${id} → ${r.candidate_name} by exact portal ID ${r.can} (health screen re-match)`, actor: user.id,
    });
    results.rematched++;
  }

  return NextResponse.json(results);
});
