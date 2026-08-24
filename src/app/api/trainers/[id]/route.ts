import { NextRequest, NextResponse } from "next/server";
import { itemRoutes } from "@/lib/crud";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { Batch, Trainer, TrainerDocument } from "@/models";
import { hasPermission, requirePerm } from "@/lib/permissions";
import { assertLocationOperational, assertTrainerDocDeleteInScope, assertTrainerDocInScope, TRAINER_FLOW } from "@/lib/rules";
import { audit } from "@/lib/audit";
import { emailError, canonicalPhone, phoneError } from "@/lib/validate";
import { maskTrainerSecrets } from "../route";

// Same masking as the list route (2026-08-12) — opening one trainer by id was the obvious way
// around a list-only filter. The field list itself lives in the list route so there is only one.
export const { GET, PATCH } = itemRoutes({
  model: Trainer, entity: "Trainer", scopeField: null,
  // QA-125 (checker, 15/08): the list's nomination/capability/home union now guards the
  // ITEM too — a scoped user could read and PATCH any trainer by id before this.
  scopeAssert: (user, item) => assertTrainerDocInScope(user, item),
  async mapItems(items, user) {
    const masked = await maskTrainerSecrets(items, await hasPermission(user, "trainers.manage"));
    // QA-111 (15/08): the Move drawer offered all 11 stages and let the server refuse the
    // pick — a dead-end that even demanded a TR ID first. The edge table is the single
    // source of truth; hand the UI exactly the moves the machine will accept.
    return masked.map((t: any) => ({ ...t, allowed_next: TRAINER_FLOW[t.pipeline_status ?? "Fresh Lead"] ?? [] }));
  },
  // The hiring-journey fields have to be writable here too — the detail page PATCHes through
  // this route, and a field missing from this list is silently dropped. pipeline_status is
  // deliberately NOT here (2026-08-13 eval sweep): a plain PATCH could jump a trainer straight
  // to "Certified", skipping every TRAINER_FLOW guard — document gates, the NSDC round-trip,
  // Rule T7. Stages move only through /transition; creation may still set an initial stage.
  fields: ["name", "phone", "email", "skills", "home_location", "home_location_other", "status", "available_from", "day_rate", "incentive_note", "max_concurrent_batches", "active", "tr_id", "capable_locations", "programs_applied", "compensation_type", "compensation_fixed", "govt_candidate_id",
    "nominated_for_location", "nominated_for_program", "source", "qualification",
    "industry_experience_years", "teaching_experience_years", "nsdc_remarks",
    "eligibility_payment_amount", "payment_reference", "tot_certificate_no", "pipeline_note",
    // -171 (QA-399) cols 5, 6, 13. -169 put these on the CREATE allowlist and missed this one -
    // the same list living in two files, which is the disease ARCHITECTURE section 3 names. They
    // are edited on the Planning tab, so the EDIT door is the one that actually matters for them.
    "sidh_profile_verified_on", "eligibility_checked_on", "tot_result_expected_on"],
  readRoles: ["Admin", "Operations", "Location"], // QA-095: same door as the list
  writeRoles: ["Admin", "Operations"],
  permission: "trainers.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // F-B5: re-pointing a trainer's nomination at a halted centre is also hiring for it.
  async beforeUpdate(_id, body, existing) {
    // QA-141 (Umesh): edits are as strict as creates — a fixed-up phone lands as the bare 10.
    if (body.phone !== undefined) {
      const pErr = phoneError(body.phone);
      if (pErr) throw new HttpError(400, pErr);
      body.phone = canonicalPhone(body.phone)!;
    }
    if (body.email !== undefined && body.email !== "") {
      const eErr = emailError(body.email, { optional: true });
      if (eErr) throw new HttpError(400, eErr);
    }
    if (body.nominated_for_location && String(body.nominated_for_location) !== String(existing.nominated_for_location ?? "")) {
      await assertLocationOperational(body.nominated_for_location, "Nominating a trainer for this centre");
    }
  },
  populate: [
    { path: "home_location", select: "name code" },
    { path: "nominated_for_location", select: "name code" },
    { path: "nominated_for_program", select: "name code scheme" },
    // QA-130 rider (Umesh: "kisne banaya"): the answer rides on the record, not just the audit log.
    { path: "created_by", select: "name email" },
  ],
});

// QA-130 (checker, 15/08): trainers had no delete verb at all, so junk rows — QA probes,
// duplicate imports — could only be Dropped and sat in every list forever (the QA-087
// disposal ended up waiting on a mongosh one-liner nobody ran). Deletion is Admin-only and
// refuses anyone referenced by a batch: a person with real history gets Dropped, not erased.
// Documents cascade; the audit row names what was removed.
export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  // 2026-08-24 (Umesh): "delete krne ka option dena hai team ko … but vo bhi respective acess wale
  // persons." This verb was never missing - it was shut behind a hard-coded Admin test, so the team
  // saw no button and reported the feature as absent. It is a togglable right now, so an Admin can
  // grant or revoke it per role and per person from the Permissions matrix.
  //
  // EVERY SAFETY REFUSAL BELOW IS UNCHANGED. Widening WHO may press the verb is not a reason to
  // soften WHAT it refuses - if anything it is the reason not to, because more people can now reach it.
  await requirePerm(user, "trainers.delete");
  const { id } = await ctx.params;
  const t = await Trainer.findById(id);
  if (!t) throw new HttpError(404, "Trainer not found");
  // QA-1008 / QA-1009 (qa-234 checker, S1): **Rule 38 was missing here, and I am the one who made it
  // reachable.** While delete was hard-coded to Admin this omission could not be hit - an Admin is
  // unscoped by definition, so no scoped user ever reached the handler. Opening the verb to
  // `candidates.delete` / `trainers.delete` did not create the hole; it woke it up. Measured by the
  // checker on the LIVE release: a Location user who gets 403 merely READING a foreign centre's
  // record got 200 DELETING it, and the record really went.
  //
  // The contrast is what proves this was an omission and not a decision: this unit's own THIRD door,
  // `api/batches/[id]`, calls `assertBatchInScope` and correctly refuses. Two of three doors had the
  // check; nobody noticed the third because nobody could reach it.
  //
  // Placed BEFORE the history/reference refusal below, deliberately. A 409 saying "this person has
  // batch history" is itself a disclosure about a record the caller may not see at all - the refusal
  // must be "not yours" before it is ever "not empty".
  // A trainer's "location" is not one field (nominated / home / capable), which is why this file
  // already owns the union helper. Reused rather than re-derived - a second spelling of "which
  // centres is this trainer attached to" is exactly the drift ARCHITECTURE section 3 exists for.
  // QA-1038 (qa-234 cycle-2 checker, S2): the STRICTER helper, because the asymmetry this had was
  // indefensible. `assertTrainerDocDeleteInScope` exists precisely because `capable_locations` is a
  // TEACHING tie and not ownership — a centre that merely CAN teach a trainer may not delete one of
  // their documents. This handler called the WIDER `assertTrainerDocInScope`, so the same SPOC was
  // refused deleting a single Aadhaar scan (403, "Only the nominating or home centre…") and allowed
  // to delete THE ENTIRE TRAINER RECORD (200). The lesser act was guarded more tightly than the
  // greater one, measured by the checker on one trainer, one user, two doors.
  //
  // Worse, the manifest that shipped this CITED that very helper as its justification for keeping
  // delete out of `.manage`. I named the right rule and then called the wrong function — §3.2c on
  // this repo's own map is about exactly that, and here it cost a real gap rather than a comment.
  //
  // Deliberately the conservative direction: this NARROWS who may delete a trainer. Erasing a whole
  // person's record must never be easier than erasing one page of their file.
  await assertTrainerDocDeleteInScope(user, id);
  if (await Batch.exists({ trainer: id })) {
    throw new HttpError(409, `${t.name} is referenced by a batch — drop the trainer instead of deleting them.`);
  }
  const docs = await TrainerDocument.deleteMany({ trainer: id });
  await t.deleteOne();
  await audit({
    entity: "Trainer", entityId: t._id,
    newValue: `deleted (${t.name}, ${t.phone}${docs.deletedCount ? `, ${docs.deletedCount} document${docs.deletedCount === 1 ? "" : "s"}` : ""})`,
    actor: user.id,
  });
  return NextResponse.json({ ok: true });
});
