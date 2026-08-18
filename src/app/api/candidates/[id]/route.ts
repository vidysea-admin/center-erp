import { NextRequest, NextResponse } from "next/server";
import { itemRoutes } from "@/lib/crud";
import { BatchMember, Candidate, CandidateDocument } from "@/models";
import { candidateEligibility } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { HttpError, apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { dbConnect } from "@/lib/db";
import { audit } from "@/lib/audit";
import { emailError, canonicalPhone, phoneError } from "@/lib/validate";

export const { GET, PATCH } = itemRoutes({
  model: Candidate, entity: "Candidate",
  fields: ["name", "phone", "alt_phone", "email", "gender", "dob", "id_reference", "location", "program", "source", "education", "last_training_date", "interested_programs", "interested_locations", "sidh_status", "sidh_link_sent_at", "sidh_registered_on", "sidh_candidate_id", "sidh_failure_reason", "fee_amount", "fee_paid_on", "fee_reference",
    // -116 (SS-01): the government-portal fields must be EDITABLE, not just creatable. The wall caught
    // this: adding them to the collection route alone let them be typed once and then silently dropped
    // on every later save — the worst shape a field can have, because nothing on screen says so.
    "salutation", "father_name", "mother_name", "marital_status", "religion", "social_category", "state", "district", "sub_district", "address_type", "differently_abled"],
  readRoles: ["Admin", "Operations", "Location", "Enrollment"], // QA-060/095: not the Trainer's lens
  writeRoles: ["Admin", "Operations", "Location", "Enrollment"],
  permission: "candidates.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // QA-141 (Umesh): edits are as strict as creates — fixed-up numbers land as the bare 10.
  beforeUpdate(_id, body) {
    if (body.phone !== undefined) {
      const pErr = phoneError(body.phone);
      if (pErr) throw new HttpError(400, pErr);
      body.phone = canonicalPhone(body.phone)!;
    }
    if (body.alt_phone !== undefined && body.alt_phone !== "") {
      const aErr = phoneError(body.alt_phone, { optional: true });
      if (aErr) throw new HttpError(400, "Alt phone: " + aErr);
      body.alt_phone = canonicalPhone(body.alt_phone)!;
    }
    if (body.email !== undefined && body.email !== "") {
      const eErr = emailError(body.email, { optional: true });
      if (eErr) throw new HttpError(400, eErr);
    }
  },
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
  ],
  async mapItems(items) {
    const defaults = await getDefaults();
    return items.map((c) => ({ ...c, eligibility: candidateEligibility(c, defaults) }));
  },
});

// QA-146 part 2 (-84, checker 15/08): three sheet header/description rows sat in the
// candidate list as people ("1"/"5", "Salutation"/"EmailID", "Input field, Mr, Ms…") and
// there was no verb to remove them — the trainer side got one in QA-130, candidates never
// did. Same shape: Admin-only, refuses anyone with batch history (a real person is Dropped,
// not erased), documents and public links cascade, the audit row names what went.
export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  if (user.role !== "Admin") throw new HttpError(403, "Only an Admin may delete a candidate.");
  const { id } = await ctx.params;
  const c = await Candidate.findById(id);
  if (!c) throw new HttpError(404, "Candidate not found");
  if (await BatchMember.exists({ candidate: id })) {
    throw new HttpError(409, `${c.name} has batch history — drop them from the batch instead of deleting the record.`);
  }
  const docs = await CandidateDocument.deleteMany({ candidate: id });
  await c.deleteOne();
  await audit({
    entity: "Candidate", entityId: c._id,
    newValue: `deleted (${String(c.name).replace(/\s+/g, " ").slice(0, 60)}, ${String(c.phone).slice(0, 30)}${docs.deletedCount ? `, ${docs.deletedCount} document${docs.deletedCount === 1 ? "" : "s"}` : ""})`,
    actor: user.id,
  });
  return NextResponse.json({ ok: true });
});
