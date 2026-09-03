import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { assertBatchInScope, updateEnrollment } from "@/lib/rules";
import { BatchMember } from "@/models";
import { audit } from "@/lib/audit";

// QA-147 (Manish, 15/08 recording): "45 bachhe × Registration/e-KYC/Batch Accept = 135
// clicks, har click ke baad page upar bhagta hai — trainer bhaag jayega." One batch's
// enrollment was ~15 minutes of clicking; the RPL cohort (8–10k students) ~45–55 hours.
// This verb marks ONE step (or all four) for many members in one request, through the
// SAME updateEnrollment path the per-card toggle uses (Rules 22–24 hold per member), and
// writes one audit row that names the count.
// Body: { step: "reg_done" | "kyc_done" | "enroll_done" | "accept_done" | "all", member_ids?: string[] }
// member_ids absent → every active (not left, not Completed-for-that-step) member.
const STEPS = ["reg_done", "kyc_done", "enroll_done", "accept_done"] as const;

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  // QA-1290: the whole point of this route is to skip 135 clicks in one request - which is
  // exactly why the missing gate here mattered more than on the per-member door. Measured live,
  // 2026-08-25: a Trainer login reached this with no permission at all and completed enrolment
  // for an entire roster with member_ids omitted (the documented default). Same key as the
  // per-member door and both sibling roster-add doors, so a bulk verb cannot hold a looser gate
  // than the one-at-a-time verb it is a shortcut for.
  await requirePerm(user, "candidates.assign"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const body = await req.json().catch(() => ({}));
  const step = String(body.step ?? "");
  if (step !== "all" && !(STEPS as readonly string[]).includes(step)) {
    throw new HttpError(400, `step must be one of ${[...STEPS, "all"].join(", ")}.`);
  }
  const ids: string[] | null = Array.isArray(body.member_ids) && body.member_ids.length ? body.member_ids.map(String) : null;
  const filter: Record<string, unknown> = { batch: id, left_on: null, ...(ids ? { _id: { $in: ids } } : {}) };
  const members = await BatchMember.find(filter).select("_id reg_done kyc_done enroll_done accept_done enrollment_status").lean<any[]>();
  // Rule 55 (QA-1824): a single step marked for the whole selection still goes through
  // updateEnrollment's step-order gate per member. The caller (the Enrollment tab's bulk button)
  // is expected to have already computed the gap client-side and asked ONE confirm covering the
  // whole selection before sending confirm_backfill — this route just forwards the flag.
  const patch: Record<string, boolean> = step === "all"
    ? { reg_done: true, kyc_done: true, enroll_done: true, accept_done: true }
    : { [step]: true, ...(body.confirm_backfill ? { confirm_backfill: true } : {}) };
  let updated = 0, skipped = 0;
  const failed: string[] = [];
  for (const m of members) {
    // Already there for every step we would set → nothing to do (idempotent).
    if (Object.keys(patch).every((k) => m[k] === true)) { skipped++; continue; }
    try { await updateEnrollment(String(m._id), patch); updated++; }
    catch (e: any) { failed.push(`${m._id}: ${e?.message ?? "error"}`); }
  }
  await audit({
    entity: "Batch", entityId: id, field: "enrollment_bulk",
    newValue: { step, requested: members.length, updated, skipped, failed: failed.length },
    actor: user.id, actorType: "USER",
  });
  return NextResponse.json({ step, requested: members.length, updated, skipped, failed });
});
