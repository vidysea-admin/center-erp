import { NextRequest, NextResponse } from "next/server";
import { itemRoutes } from "@/lib/crud";
import { BatchMember, Candidate, CandidateDocument } from "@/models";
import { candidateEligibility } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { HttpError, apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { dbConnect } from "@/lib/db";
import { audit } from "@/lib/audit";
import { emailError, canonicalPhone, phoneError } from "@/lib/validate";

// QA-714 / QA-719 (-210): what a portal Candidate ID has to LOOK like at a hand-typed door.
// Deliberately NOT `normalizeCan` - that is the MATCHER (/CAN[\s_-]*(\d+)/i) and it reads only
// digits after CAN, so using it as a format refused `CAN_ED0711202`, a shape this product stores
// and every suite uses. The wall caught that in eleven assertions before it shipped. The rule is
// the one the data actually obeys: begins with CAN, and carries at least one digit.
const looksLikeCan = (s: unknown) => /^\s*CAN[\s_-]?[A-Za-z0-9-]*\d[A-Za-z0-9-]*\s*$/i.test(String(s ?? ""));

export const { GET, PATCH } = itemRoutes({
  model: Candidate, entity: "Candidate",
  fields: ["name", "phone", "alt_phone", "email", "gender", "dob", "id_reference", "location", "program", "source", "education", "last_training_date", "interested_programs", "interested_locations", "sidh_status", "sidh_link_sent_at", "sidh_registered_on", "sidh_candidate_id", "sidh_failure_reason", "fee_amount", "fee_paid_on", "fee_reference",
    // -116 (SS-01): the government-portal fields must be EDITABLE, not just creatable. The wall caught
    // this: adding them to the collection route alone let them be typed once and then silently dropped
    // on every later save — the worst shape a field can have, because nothing on screen says so.
    "salutation", "father_name", "mother_name", "marital_status", "religion", "social_category", "state", "district", "sub_district",
    // -126 (S18-03): address_type and differently_abled removed — they were never in his spoken list
    // of eight, and he asked for them back out.
    // -134 (QA-283): the human-applied "documents were done on SIDH" mark. On BOTH doors — a field
    // the item route does not accept looks saved and is gone on the next read (the -116 lesson).
    "sidh_docs_verified",
  ],
  readRoles: ["Admin", "Operations", "Location", "Enrollment"], // QA-060/095: not the Trainer's lens
  writeRoles: ["Admin", "Operations", "Location", "Enrollment"],
  permission: "candidates.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // QA-141 (Umesh): edits are as strict as creates — fixed-up numbers land as the bare 10.
  beforeUpdate(_id, body, _existing, user) {
    // -156 (QA-450): null, not "" - clearing the field has to stay possible, and the QA-417 partial
    // index does not index null. Same reasoning as the create door one file over.
    if (typeof body.sidh_candidate_id === "string" && !body.sidh_candidate_id.trim()) body.sidh_candidate_id = null;
    // QA-714 (-210, checker on qa-208): this field was written with NO validation while every reader
    // of it counts through `normalizeCan` (/CAN[\s_-]*(\d+)/i). So "CAN_CHK208A" and "40918461" both
    // saved, both audited as a real change, and the student stayed on the blocked list with nothing
    // on screen to say why - the operator cannot tell a working id from a broken one. Worse, the
    // junk then PERMANENTLY blocks the automatic linker for that candidate, because
    // POST /link-portal-ids only ever fills an EMPTY id. -208 put this input on the tab a centre uses
    // every day, and Umesh's team is about to type ten of them.
    // Refused at the door rather than in the widget, so every caller is covered - the Candidates
    // drawer has had this input since -116.
    if (typeof body.sidh_candidate_id === "string" && body.sidh_candidate_id.trim() && !looksLikeCan(body.sidh_candidate_id)) {
      throw new HttpError(400, `"${body.sidh_candidate_id.trim()}" is not a portal Candidate ID. It reads like CAN_12345678 — the letters CAN followed by the number. Copy it from SIDH exactly as it appears there.`);
    }
    // -135 (QA-283): the caller may say "these documents were done on SIDH". It does NOT get to say
    // WHO confirmed it or WHEN — the server stamps both from the session, because a mark whose
    // provenance the client can write is not evidence, it is a field. Clearing it clears them too,
    // so an un-marked record never keeps a stale signature.
    if (body.sidh_docs_verified !== undefined) {
      const on = body.sidh_docs_verified === true || body.sidh_docs_verified === "true";
      body.sidh_docs_verified = on;
      body.sidh_docs_verified_by = on ? user.id : null;
      body.sidh_docs_verified_on = on ? new Date() : null;
    }
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
