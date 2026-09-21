import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, readJson, translateError } from "@/lib/authz";
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
  const body = await readJson(req).catch(() => ({}));
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
  const needs_clear: string[] = [];
  for (const m of members) {
    // QA-2811. A member marked Failed is left EXACTLY as it is — status and booleans both — and
    // reported under its own name. Decided by Umesh, 2026-09-21, verbatim: "Bulk Failed ko haath na
    // lagaye, sirf saaf bole" (qa/gates/qa-2811-bulk-clear-failed.md).
    //
    // What this route did before: it sent the four booleans and no `failed` key, so `patch.failed`
    // was `undefined`, the recompute guard at rules.ts:947 (`enrollment_status !== "Failed" ||
    // patch.failed === false`) never fired, and the member was saved with four `true` booleans and
    // a "Failed" status — counted as `updated`, reported as success. The contract does not settle
    // whether completing four steps CLEARS a Failed (REQ-136 makes setting one deliberate; REQ-135
    // says Failed overrides "until cleared" without saying what clears it), so the question went to
    // Umesh rather than being decided here.
    //
    // Ticking the booleans while leaving the status is the one thing NOT to do: it manufactures the
    // 4/4-and-Failed row that made this confusing. `continue` before the patch, not after.
    //
    // And it is NOT `skipped`: that bucket means "already done", which would be a second false
    // statement about the same member. Clearing stays the per-member door's deliberate act.
    if (m.enrollment_status === "Failed") { needs_clear.push(String(m._id)); continue; }
    // Already there for every step we would set → nothing to do (idempotent).
    // NOTE (QA-2820): a member corrupted by the old behaviour — four `true` booleans still carrying
    // a "Failed" status — is caught by the Failed branch above now, so it reports honestly instead
    // of falling in here and being counted as already done. This route still does not REPAIR it;
    // that needs the explicit clear, same as any other Failed member.
    if (Object.keys(patch).every((k) => m[k] === true)) { skipped++; continue; }
    try { await updateEnrollment(String(m._id), patch); updated++; }
    // QA-2799: sibling of QA-2796 — this used to be `e?.message` verbatim into a 200 response.
    catch (e: any) { failed.push(`${m._id}: ${translateError(e).message}`); }
  }
  await audit({
    entity: "Batch", entityId: id, field: "enrollment_bulk",
    newValue: { step, requested: members.length, updated, skipped, failed: failed.length, needs_clear: needs_clear.length },
    actor: user.id, actorType: "USER",
  });
  return NextResponse.json({ step, requested: members.length, updated, skipped, failed, needs_clear });
});
