import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BatchMember, Candidate, CandidateResult, GovtAttendanceRow } from "@/models";
import { assertBatchInScope, enrolledWithoutCan } from "@/lib/rules";
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
    // -159 cycle 2 (QA-476): the phone rides along - this list names people a human has to go and
    // resolve by hand, which is exactly the case a bare name cannot serve (REQ-389).
    .populate("candidate", "name phone sidh_candidate_id").lean<any[]>();
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
      conflicts.push({ candidate: cid, name: cand.name, phone: cand.phone ?? null, ids: entries.map(([can, v]) => ({ can, from: v.from })) });
      continue;
    }
    const [can, v] = entries[0];
    if (cand.sidh_candidate_id) {
      // Only worth mentioning when the portal disagrees with what is on record.
      if (canOf(cand.sidh_candidate_id) !== can) {
        conflicts.push({ candidate: cid, name: cand.name, phone: cand.phone ?? null, on_record: cand.sidh_candidate_id, portal_says: can, from: v.from, note: "already on record and different — left untouched" });
      } else {
        already.push({ candidate: cid, name: cand.name, id: cand.sidh_candidate_id });
      }
      continue;
    }
    linkable.push({ candidate: cid, name: cand.name, id: v.raw, can, from: v.from, matched_by: v.by });
  }

  const withId = members.filter((m) => canOf(m.candidate?.sidh_candidate_id)).length;

  // -205 (Umesh, 23/08): "ye jo 10 students remaining hai, ye 10 hai kaun se? ... team ko kya, mujhe
  // bhi nahi pata chala ki wo 10 bachche hain kaun se, jinki candidate id nahi hai."
  //
  // `without_portal_id` has always been a COUNT, and the screen that prints it says "map by hand
  // below" while naming nobody. A count is not actionable: it tells a centre that ten people are
  // missing an id and gives them no way to find out which ten. So the list rides along, with the
  // phone (REQ-389 — two students on this very roster share a name) and with the RESULT, because
  // his next question was whether the ten are the ones who failed.
  // QA-704 / QA-701 (-207, checker on qa-205): -205 put a SECOND count of "who has no portal ID" on
  // the same screen and made the Overview caption point at it. On the Gurugram shape the screen then
  // gave three different numbers - 1, 7 and 8 - for the single question Umesh had asked, because this
  // route counted every member on the roster while the gate that actually blocks certification
  // (`enrolledWithoutCan`, honoured at rules.ts's deriveCompletion) counts only ENROLLED ones, and
  // `without_portal_id` was computed by subtraction so an orphaned member vanished from the list but
  // stayed in the count. That is the QA-676 fault reshipped inverted by the unit that existed to
  // remove it.
  //
  // One function decides WHO, and it is the one the gate honours. This route only adds the detail a
  // person needs to act on the row. The count is the length of that list, never a subtraction.
  const gateMissing = await enrolledWithoutCan(batchId);
  const memberById = new Map(members.map((m) => [String(m._id), m]));
  const resultRows = gateMissing.length
    ? await CandidateResult.find({ batch: batchId, batch_member: { $in: gateMissing.map((g) => g.member) } })
      .select("batch_member result certificate_status").lean<any[]>()
    : [];
  const resultByMember = new Map(resultRows.map((r) => [String(r.batch_member), r]));
  const missing = gateMissing.map((g) => {
    const m = memberById.get(g.member);
    const r = resultByMember.get(g.member);
    return {
      candidate: m?.candidate?._id ? String(m.candidate._id) : null,
      member: g.member,
      name: g.name,
      phone: g.phone ?? null,
      result: r?.result ?? "Pending",
      certificate_status: r?.certificate_status ?? null,
    };
  });

  // Two sets live here and they answer two different questions, so they are named apart and the
  // screen never mixes them:
  //
  //   roster / with_portal_id / without_portal_id  - the WHOLE roster. This is the certificate
  //     MATCHING question ("N of M candidates carry a portal ID"): a file named for a candidate has
  //     to find them whether or not their enrolment is complete. My first attempt at QA-704 pointed
  //     these at the gate set too, and the wall caught it immediately - six assertions came back
  //     reporting roster 0, because a fixture roster is not `enrollment_status: "Completed"`. That
  //     would have silently emptied this panel for real rosters in the same state.
  //
  //   missing - the students who are actually BLOCKING certification, from `enrolledWithoutCan`,
  //     the one function the gate honours. This is the list the screen opens and the caption on the
  //     Overview points at, and its length is the only number printed beside it (QA-701: the panel
  //     used to print a roster-wide count next to a button offering a shorter list).
  return {
    roster: members.length,
    with_portal_id: withId,
    without_portal_id: members.length - withId,
    missing,
    blocking: missing.length,
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
