import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, CandidateResult, Closure } from "@/models";
import { assertBatchInScope, activeRoster, enrolledWithoutCan, recomputeClosureAggregates, transitionBatch, upsertCandidateResult } from "@/lib/rules";
import { audit } from "@/lib/audit";

// -113 (Umesh, 18/08: "admin ke paas mark completed ka button aaye, aur wo press kar paye — jaise
// abhi wala press bhi nahi ho raha na").
//
// The two Mark-Completed buttons and the batch transition each refuse until the ROWS say they may
// fire: Rule 43 wants every roster member to carry a final result, Rule 46 wants every pass to hold
// a settled certificate. On AVP-GURU-RPLAVP-DST-01 that is 26 unmarked students and one pass with no
// certificate — real, missing facts, and the rules are right to hold. But an Admin looking at a batch
// that finished months ago has no way to say "this is how it ended" and be done.
//
// So this is the ADMIN door, built in the shape this codebase already uses for exactly this problem
// (Rule 19: a batch with daily logs may be force-closed by an Admin, with a reason). It does NOT
// weaken a rule and it does NOT invent a number. It writes the honest default for each outstanding
// row — a student with no result is FAILED (Umesh, -204; it wrote ABSENT until then), a pass with no
// certificate is NOT ISSUED — every row
// audited by name, under one reason the Admin types, and only then walks the batch to Completed.
//
// GET returns exactly what a press would settle, so the screen can say it before anything happens.

async function outstanding(batchId: string) {
  // activeRoster is already the NOT-dropped roster (left_on: null) — the same list Rule 43 walks.
  // -159 (QA-472): the PHONE rides on both lists. REQ-389 is the reason and it is not a preference:
  // "the portal ID when present, otherwise the phone" - and on the roster this week has been about,
  // two students share a name, so a list of names identifies nobody. -158 fixed one screen that had
  // this defect and left three; this is the payload all three of them read.
  const roster = await activeRoster(batchId);
  const live = new Set(roster.map((m: any) => String(m._id)));
  const rows = await CandidateResult.find({ batch: batchId }).populate("candidate", "name phone").lean<any[]>();
  const byMember = new Map(rows.map((r) => [String(r.batch_member), r]));
  // An UNMARKED member may have no result row at all, so the name cannot come from the row - it has
  // to come from the roster. Before this, a member with no row got `name: undefined` and was
  // rendered as nothing at all by the surfaces that .filter(Boolean) their names.
  const withCand = await BatchMember.find({ batch: batchId, left_on: null })
    .populate("candidate", "name phone").select("candidate").lean<any[]>();
  const candByMember = new Map(withCand.map((m: any) => [String(m._id), m.candidate]));
  const unmarked: { member: string; name?: string; phone?: string | null }[] = [];
  for (const m of roster) {
    const row = byMember.get(String(m._id));
    const cand = row?.candidate ?? candByMember.get(String(m._id));
    if (!row || row.result === "Pending") unmarked.push({ member: String(m._id), name: cand?.name, phone: cand?.phone ?? null });
  }
  const unsettled = rows.filter((r) => r.result === "Pass" && live.has(String(r.batch_member))
    && !["Issued", "Not Issued"].includes(r.certificate_status))
    .map((r) => ({ id: String(r._id), name: r.candidate?.name, phone: r.candidate?.phone ?? null, status: r.certificate_status, has_file: !!r.certificate_file }));
  return { unmarked, unsettled, roster_count: roster.length, marked: roster.length - unmarked.length };
}

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "batches.manage");
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);
  const batch = await Batch.findById(id).select("status code").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  const o = await outstanding(id);
  const closure = await Closure.findOne({ batch: id }).select("assessment_status certification_status").lean<any>();
  // -205 (QA-676): the caption on the Overview said "Waiting on certificates" whenever certification
  // was Pending, and on the Gurugram batch that sentence was FALSE - zero certificates outstanding,
  // 17 of 17 Issued. The real hold was the portal ID, which the caption never mentions and this
  // payload never carried. Umesh went looking for a certificate problem because the screen sent him
  // there. A screen that names the wrong cause is worse than one that says nothing.
  const noCan = await enrolledWithoutCan(id);
  return NextResponse.json({
    status: batch.status,
    can_complete_cleanly: o.unmarked.length === 0 && o.unsettled.length === 0,
    admin_only: true,
    ...o,
    no_portal_id: noCan,
    closure: { assessment_status: closure?.assessment_status ?? "Pending", certification_status: closure?.certification_status ?? "Pending" },
  });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  requireRole(user, "Admin"); // same shape as Rule 19's force-close: this is an override, not a step
  await requirePerm(user, "batches.manage");
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);

  const body = await req.json().catch(() => ({}));
  const reason = String(body.reason ?? "").trim();
  if (!reason) throw new HttpError(400, "Say why this batch is being completed with rows still outstanding — it is recorded against every row this settles.");

  const batch = await Batch.findById(id).select("status code").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  if (["Completed", "Closed"].includes(batch.status)) return NextResponse.json({ item: batch, settled: { failed: 0, not_issued: 0 }, already: true });
  if (batch.status === "Cancelled") throw new HttpError(409, "A cancelled batch cannot be completed.");
  if (!["Active", "Closing"].includes(batch.status)) throw new HttpError(409, `A batch in ${batch.status} has not started yet — start it before completing it.`);

  const o = await outstanding(id);
  const today = new Date();

  // 1. A student left unmarked when the Admin closes the batch is FAILED. Written through the
  //    ordinary marking door, so every guard that applies to a hand-typed result applies here too.
  //
  //    -204: this wrote "Absent" until Umesh was asked directly and chose otherwise (22/08, on the
  //    Gurugram batch): "jitne bachche remaining hain jinke certificate nahi hai, woh bachche fail
  //    ho gaye". He was shown the alternative in as many words - that a student who never sat the
  //    assessment is Absent, not Fail, and that the two are different facts on the client's sheet -
  //    and he was offered a split driven by attendance. He chose one word for all of them, and it is
  //    his record and his client. The distinction is not lost: the audit row below says the result
  //    was written by an Admin completing the batch, and names the reason they gave.
  //    Rule 44 refuses a Fail with no failure_reason, and it is right to: a fail nobody explained is
  //    useless to everyone downstream. The wall caught this the moment the result changed - eight
  //    assertions went red on "a Fail result requires a failure reason". So the reason is written
  //    too, and it says the true thing rather than a placeholder: this student was never marked, and
  //    the batch was completed anyway, by whom and why.
  for (const u of o.unmarked) {
    await upsertCandidateResult(id, u.member, {
      result: "Fail",
      assessed_on: today,
      failure_reason: `No result was recorded before ${batch.code} was completed by an Admin: ${reason}`,
    }, user.id);
    await audit({ entity: "BatchMember", entityId: u.member, field: "result",
      oldValue: "no result", newValue: `Fail — recorded by Admin completing ${batch.code}: ${reason}`, actor: user.id, actorType: "USER" });
  }

  // 2. A pass with no settled certificate is NOT ISSUED. This is the one place the Rule 46 ladder is
  //    stepped over rather than walked (Pending has no legal hop to Not Issued) — which is what an
  //    Admin override IS, and it is named on the row, not silent.
  for (const c of o.unsettled) {
    const row = await CandidateResult.findById(c.id);
    if (!row) continue;
    const was = row.certificate_status;
    row.certificate_status = "Not Issued";
    row.certificate_rejection_reason = `No certificate on record when the batch was completed by an Admin: ${reason}`;
    await row.save();
    await audit({ entity: "CandidateResult", entityId: row._id, field: "certificate_status",
      oldValue: was, newValue: `Not Issued — Admin completed ${batch.code} with no certificate for ${c.name ?? "this candidate"}: ${reason}`, actor: user.id, actorType: "USER" });
  }

  // 3. Now the ordinary rules can fire on their own: the sign-offs derive from the rows, and the
  //    batch walks its own ladder through the same doors the buttons use. Nothing is bypassed here.
  await recomputeClosureAggregates(id, user.id);
  const fresh = await Batch.findById(id).select("status").lean<any>();
  if (fresh?.status === "Active") await transitionBatch(id, "Closing", { isAdmin: true, reason, actor: user.id });
  const done = await transitionBatch(id, "Completed", { isAdmin: true, reason, actor: user.id });

  await audit({ entity: "Batch", entityId: id, field: "completed_by_admin",
    newValue: `Completed by Admin — ${o.unmarked.length} student(s) recorded Fail, ${o.unsettled.length} certificate(s) Not Issued — ${reason}`,
    actor: user.id, actorType: "USER" });
  return NextResponse.json({ item: done, settled: { failed: o.unmarked.length, not_issued: o.unsettled.length } });
});
