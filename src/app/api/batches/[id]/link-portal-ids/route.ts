import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BatchMember, Candidate, GovtAttendanceRow } from "@/models";
import { assertBatchInScope } from "@/lib/rules";
import { normalizeCan } from "@/lib/govt-attendance";
import { audit } from "@/lib/audit";

// -108: link this batch's roster to the portal IDs the ERP ALREADY holds.
//
// Umesh, 17/08, on eight certificate files every one of which was refused with "matches no
// candidate on this batch's roster": the files were right. Not one of the 39 candidates on
// AVP-GURU-RPLAVP-DST-01 carried a `sidh_candidate_id`, and that field is the only key the
// certificate matcher joins on — so its lookup was empty and every file had to fail, while the
// screen blamed the file.
//
// The mapping was never missing, only unwritten: the portal import had already matched all 24 rows
// to those candidates BY NAME and stored each CAN id on the GovtAttendanceRow. -108 makes new
// imports stamp it; this door does the same for everything imported before, so nobody has to
// re-upload a file they already imported.
//
// GET  → what WOULD be linked, writing nothing (so the screen can offer "Link portal IDs (24)").
// POST → link them, one audit row each.
//
// Only `Matched` rows are read (an Ambiguous row is the importer refusing to guess between two
// same-name candidates — it must never write an identity field), an id already on record is never
// overwritten, and a candidate whose matched rows disagree about the id is reported as a conflict
// and left alone rather than resolved by luck.

// -155: the local copy became the shared normalizeCan in lib/govt-attendance - the health screen
// and the ID-re-match need the identical test, and near-identical regexes are how doors drift.
const canOf = normalizeCan;

async function plan(batchId: string) {
  const members = await BatchMember.find({ batch: batchId })
    .populate("candidate", "name sidh_candidate_id").lean<any[]>();
  const candIds = members.map((m) => m.candidate?._id).filter(Boolean);
  const byCand = new Map(members.filter((m) => m.candidate).map((m) => [String(m.candidate._id), m.candidate]));

  const rows = candIds.length
    ? await GovtAttendanceRow.find({ candidate: { $in: candIds }, match_status: "Matched" })
      .populate("import", "period_label file_name")
      .select("candidate govt_candidate_id match_by import createdAt").lean<any[]>()
    : [];

  // Collect every distinct id the portal has ever asserted for each candidate.
  const seen = new Map<string, Map<string, any>>();
  for (const r of rows) {
    const can = canOf(r.govt_candidate_id);
    if (!can) continue;
    const cid = String(r.candidate);
    if (!seen.has(cid)) seen.set(cid, new Map());
    if (!seen.get(cid)!.has(can)) {
      seen.get(cid)!.set(can, { raw: String(r.govt_candidate_id).trim(), from: r.import?.period_label || r.import?.file_name || "an import", by: r.match_by });
    }
  }

  const linkable: any[] = [];
  const already: any[] = [];
  const conflicts: any[] = [];
  for (const [cid, ids] of seen) {
    const cand = byCand.get(cid);
    if (!cand) continue;
    const entries = [...ids.entries()];
    if (entries.length > 1) {
      conflicts.push({ candidate: cid, name: cand.name, ids: entries.map(([can, v]) => ({ can, from: v.from })) });
      continue;
    }
    const [can, v] = entries[0];
    if (cand.sidh_candidate_id) {
      // Only worth mentioning when the portal disagrees with what is on record.
      if (canOf(cand.sidh_candidate_id) !== can) {
        conflicts.push({ candidate: cid, name: cand.name, on_record: cand.sidh_candidate_id, portal_says: can, from: v.from, note: "already on record and different — left untouched" });
      } else {
        already.push({ candidate: cid, name: cand.name, id: cand.sidh_candidate_id });
      }
      continue;
    }
    linkable.push({ candidate: cid, name: cand.name, id: v.raw, can, from: v.from, matched_by: v.by });
  }

  const withId = members.filter((m) => canOf(m.candidate?.sidh_candidate_id)).length;
  return {
    roster: members.length,
    with_portal_id: withId,
    without_portal_id: members.length - withId,
    linkable, already, conflicts,
  };
}

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "closure.manage");
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  return NextResponse.json(await plan(id));
});

export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage");
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38

  const p = await plan(id);
  let linked = 0;
  for (const l of p.linkable) {
    // Conditional on the field STILL being empty — two operators clicking at once cannot
    // overwrite each other, and an id set in between wins.
    const res = await Candidate.updateOne(
      { _id: l.candidate, $or: [{ sidh_candidate_id: null }, { sidh_candidate_id: "" }, { sidh_candidate_id: { $exists: false } }] },
      { $set: { sidh_candidate_id: l.id } },
    );
    if (!res.modifiedCount) continue;
    linked++;
    await audit({
      entity: "Candidate", entityId: l.candidate, field: "sidh_candidate_id",
      oldValue: null,
      newValue: `${l.id} — linked from the portal attendance already imported (${l.from}, matched by ${l.matched_by})`,
      actor: user.id, actorType: "USER",
    });
  }
  const after = await plan(id);
  return NextResponse.json({
    linked,
    already_had_one: p.already.length,
    conflicts: p.conflicts,
    roster: after.roster,
    with_portal_id: after.with_portal_id,
    without_portal_id: after.without_portal_id,
  });
});
