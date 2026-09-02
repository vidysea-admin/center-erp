import { NextRequest, NextResponse } from "next/server";
import { itemRoutes } from "@/lib/crud";
import { BatchMember, Candidate, CandidateDocument } from "@/models";
import { candidateEligibility } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { HttpError, apiHandler, isScoped, requireEdit, requireUser } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { dbConnect } from "@/lib/db";
import { audit } from "@/lib/audit";
import { aadhaarError, canonicalAadhaar, apaarError, canonicalApaar, sameGovtNumber, emailError, canonicalPhone, phoneError } from "@/lib/validate";
import { looksLikeCan, normalizeCan } from "@/lib/govt-attendance";

// QA-447: same prefilter portal-id-health/route.ts uses for the identical reason.
const CAN_SHAPE = /CAN/i;

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
    // 2026-08-24 (Umesh): the Aadhaar number must be EDITABLE, not just creatable — the -116 lesson,
    // which the wall caught then: a field on the create door alone is typed once and silently dropped
    // on every later save, which is the worst shape a field can have because nothing on screen says so.
    "aadhaar_no",
    // QA-945 (2026-08-24): "interested in current upcoming batch" vs "future batches". On BOTH
    // doors - a field the item route does not accept looks saved and is gone on the next read.
    "batch_interest",
    // 2026-08-24 (Umesh): the APAAR ID must be EDITABLE, not just creatable — the -116 lesson, for
    // the third time in this list. A wrong government id is fixed by correcting it, and a field only
    // the create door accepts cannot be corrected at all.
    "apaar_id",
  ],
  readRoles: ["Admin", "Operations", "Location", "Enrollment"], // QA-060/095: not the Trainer's lens
  writeRoles: ["Admin", "Operations", "Location", "Enrollment"],
  permission: "candidates.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // QA-141 (Umesh): edits are as strict as creates — fixed-up numbers land as the bare 10.
  async beforeUpdate(_id, body, existing, user) {
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
    //
    // QA-726 (-212, checker on qa-210): ONLY when the value actually CHANGED. -210 validated every
    // PATCH that carried the field, and the Candidates drawer re-sends it on EVERY edit (openEdit
    // loads it into the form) - so a record already holding an old junk id, typed before -210 or
    // written by the bulk importer that still has no guard, became UNEDITABLE. Measured by the
    // checker: changing only the EMAIL of three imported candidates returned 400 naming a portal ID
    // the operator had not touched. A guard on newly typed input must never retroactively freeze
    // records that already hold the thing it now refuses - the fix for those is to correct them,
    // and this made correcting them the one thing you could not do.
    if (typeof body.sidh_candidate_id === "string" && body.sidh_candidate_id.trim()
      && body.sidh_candidate_id.trim() !== String((existing as any)?.sidh_candidate_id ?? "").trim()
      && !looksLikeCan(body.sidh_candidate_id)) {
      throw new HttpError(400, `"${body.sidh_candidate_id.trim()}" is not a portal Candidate ID. It reads like CAN_12345678 - the letters CAN followed by the number. Copy it from SIDH exactly as it appears there.`);
    }
    // QA-730: store what was validated, not that value plus whatever whitespace arrived with it.
    // The QA-417 partial unique index is built on the RAW string, so "  CAN_12345678  " does not
    // collide with the same id another candidate already holds, and the health screen's duplicate
    // bucket groups on the raw value too - so neither sees the pair.
    if (typeof body.sidh_candidate_id === "string") body.sidh_candidate_id = body.sidh_candidate_id.trim();
    // QA-447: the QA-417 unique index (and QA-730's own trim above) only stop a BYTE-IDENTICAL
    // second write - "CAN_5302339001", "CAN5302339001" and "can 5302339001" are the same government
    // identity to every reader of this field but three different strings to the index. Same "only
    // when the value actually CHANGED" gate QA-726 established above (a record already holding an
    // old id must stay editable for everything else about it), checked here rather than by widening
    // the index to a normalised key, which would need migrating everything already stored (QA-719,
    // Umesh's call).
    if (typeof body.sidh_candidate_id === "string" && body.sidh_candidate_id
      && body.sidh_candidate_id !== String((existing as any)?.sidh_candidate_id ?? "").trim()) {
      const canon = normalizeCan(body.sidh_candidate_id);
      if (canon) {
        const holders = await Candidate.find({ sidh_candidate_id: CAN_SHAPE, _id: { $ne: _id } })
          .select("name sidh_candidate_id").lean<any[]>();
        const clash = holders.find((c) => normalizeCan(c.sidh_candidate_id) === canon);
        if (clash) {
          throw new HttpError(409, `This portal Candidate ID is already recorded for ${clash.name} `
            + `(stored there as "${clash.sidh_candidate_id}" - the same government identity, written `
            + `differently). One portal ID belongs to one candidate.`);
        }
      }
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
    // 2026-08-24: Aadhaar, with the QA-726 rule applied from the start rather than after it bites.
    // -210 validated a portal ID on EVERY patch that carried the field, and the drawer re-sends every
    // field on every edit — so a record already holding a bad value became UNEDITABLE, and correcting
    // it was the one thing you could not do. Measured then: changing only the EMAIL of three imported
    // candidates returned 400 naming an id the operator had not touched.
    //
    // So: only when the value actually CHANGED. Bulk import writes this field too and does not refuse
    // rows over format, so records holding an unvalidatable Aadhaar will exist by design, and fixing
    // the phone number on one of them must not be blocked by it.
    if (body.aadhaar_no !== undefined) {
      // QA-1454: body.aadhaar_no is null when the caller means "clear it" (the -156/QA-450 rule
      // two blocks up), and String(null) is the 4-character string "null" - truthy, so the
      // clearing branch below never fired and "null" fell through to be judged as a real Aadhaar
      // number. `?? ""` turns a genuine null into the empty string BEFORE String()/trim() ever
      // sees it; a real string value passes through untouched.
      const incoming = String(body.aadhaar_no ?? "").trim();
      const current = String((existing as any)?.aadhaar_no ?? "").trim();
      if (!incoming) {
        body.aadhaar_no = null; // clearing it must stay possible — that is how a wrong one is removed
      } else if (incoming !== current) {
        const aErr = aadhaarError(incoming, { optional: true });
        if (aErr) throw new HttpError(400, aErr);
        body.aadhaar_no = canonicalAadhaar(incoming)!;
        // QA-950 (-232 cycle 1, checker): the QA-414 guard was asked in ONE direction only. Setting
        // the APAAR first and the Aadhaar second walked straight past it - PATCH {apaar_id:X} → 200,
        // then PATCH {aadhaar_no:X} → 200, and the record ends holding the same 12 digits in both
        // government-ID fields, which is the precise state the guard exists to prevent. A guard that
        // depends on the ORDER the operator happens to type in is not a guard. Asked here against
        // whichever APAAR this save leaves on the record - the incoming one when the form sent it,
        // otherwise the stored one - exactly as the apaar_id block below asks it of the Aadhaar.
        // QA-977: compare DIGITS, not validity. canonicalApaar/canonicalAadhaar are format tests and
        // either side failing one made the guard silently unfireable - including for an APAAR
        // beginning 0 or 1, which is a shape the government really issues.
        const apaarAfter = body.apaar_id !== undefined ? body.apaar_id : (existing as any)?.apaar_id;
        if (sameGovtNumber(apaarAfter, body.aadhaar_no)) {
          throw new HttpError(400, "That is this candidate's APAAR ID, not their Aadhaar number. They are both 12 digits and are different numbers — the Aadhaar number is the one on their Aadhaar card.");
        }
      } else {
        body.aadhaar_no = current; // unchanged: pass through untouched, never re-judged
      }
    }
    // QA-902 (2026-08-24): the APAAR ID, with the QA-726 rule built in from the first line rather
    // than added after it bites. The drawer re-sends EVERY field on every edit, so validating a
    // value that did not change is what made records holding an old bad portal id uneditable in
    // every other field — measured then: changing only the EMAIL of three imported candidates
    // returned 400 naming an id the operator had not touched. The bulk importer writes this field
    // and does not refuse rows over format, so records holding an unvalidatable APAAR will exist by
    // design, and fixing the phone number on one of them must never be blocked by it.
    if (body.apaar_id !== undefined) {
      // QA-1454: same fix as the aadhaar_no block above - body.apaar_id is null when the caller
      // means "clear it", and String(null) is the truthy string "null", so the clearing branch
      // never fired and any save (even an unrelated field, since the drawer re-sends every field
      // on every edit) on a candidate with no APAAR ID recorded threw a false "APAAR ID is 12
      // digits" 400.
      const incoming = String(body.apaar_id ?? "").trim();
      const current = String((existing as any)?.apaar_id ?? "").trim();
      if (!incoming) {
        body.apaar_id = null; // clearing it must stay possible — that is how a wrong one is removed
      } else if (incoming !== current) {
        const apErr = apaarError(incoming, { optional: true });
        if (apErr) throw new HttpError(400, apErr);
        body.apaar_id = canonicalApaar(incoming)!;
        // The QA-414 guard, asked against whichever Aadhaar this save leaves on the record — the
        // incoming one when the form sent it, otherwise the stored one.
        // QA-977: the same equality test, so the two directions cannot drift apart again.
        const aadhaarAfter = body.aadhaar_no !== undefined ? body.aadhaar_no : (existing as any)?.aadhaar_no;
        if (sameGovtNumber(body.apaar_id, aadhaarAfter)) {
          throw new HttpError(400, "That is this candidate's Aadhaar number, not their APAAR ID. They are both 12 digits and are different numbers — the APAAR ID is the academic account number from the government portal.");
        }
      } else {
        body.apaar_id = current; // unchanged: pass through untouched, never re-judged
      }
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
export const DELETE = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
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
  await requirePerm(user, "candidates.delete");
  const { id } = await ctx.params;
  const c = await Candidate.findById(id);
  if (!c) throw new HttpError(404, "Candidate not found");
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
  if (isScoped(user)) {
    // Fail closed, exactly as itemRoutes' GET/PATCH do (crud.ts): a record with NO centre is not
    // visible to a scoped user either, so it is not deletable by one.
    const locId = (c as any).location;
    if (!locId || !user.location_scope.map(String).includes(String(locId))) {
      throw new HttpError(403, "Out of scope");
    }
  }
  const body = ((await req.json().catch(() => ({}))) as any) ?? {};
  const hasHistory = await BatchMember.exists({ candidate: id });
  if (hasHistory && !body.confirm_batch_history) {
    // QA-1800 (Umesh, 2026-09-02 ~17:05 IST, qa/feedback-inbox.md: "yes with confirmation"):
    // a candidate WITH batch history CAN now be archived - this used to be an outright refusal
    // (QA-904: "a real person is Dropped, not erased"), and that refusal was correct for ERASURE,
    // which stays impossible below regardless of this flag. It was never a decision about ARCHIVE,
    // which did not exist yet when QA-904 was written. So this is now a CONFIRMATION GATE, not a
    // refusal: the caller must say `confirm_batch_history: true` to proceed, and the audit line
    // below records that the operator was told.
    throw new HttpError(409, `${c.name} has batch history — confirm to archive anyway (their batch record stays; only the candidate is archived).`);
  }
  // QA-1792: THIS DOOR NO LONGER DESTROYS ANYTHING.
  //
  // It used to run `CandidateDocument.deleteMany` + `c.deleteOne()`. The 409 above is the only
  // thing that ever stood between a candidate and permanent erasure, and it only fires for people
  // who already have batch history - so a fresh lead, which is exactly who the client's team
  // clears with this button ("galti se ye deleted wale chale ja rahe hain"), was destroyed along
  // with their documents. The 2026-09-02 client call walked through this door and the record only
  // survived because that candidate happened to have history.
  //
  // Recorded client call, item 3: "delete ke badle ARCHIVE kar dena hai ... with proper reason,
  // aur us student ka status archive ho jayega". Umesh's gate answer (qa/feedback-inbox.md,
  // 2026-09-02 ~13:35) settled that Archive is a SEPARATE state and REQ-417-421 stands, so this
  // stamps the archive fields and changes nothing about who is visible where - that is the next
  // unit's job, and doing it here would hide people the 25-Aug decision deliberately kept visible.
  //
  // QA-1800: the 409 above is now a CONFIRMATION GATE, not the final refusal it used to be -
  // Umesh widened this door on 2026-09-02. Erasure is still impossible either way; only the
  // question "can this person be archived at all" changed, and it is answered above.
  const reason = String(body.reason ?? "").trim();
  c.set({ archived_at: new Date(), archive_reason: reason || null, archived_by: user.id });
  await c.save();
  await audit({
    entity: "Candidate", entityId: c._id, field: "archived_at",
    newValue: `archived${reason ? ` — ${reason.slice(0, 120)}` : " (no reason given)"}${hasHistory ? " (had batch history, confirmed)" : ""}`,
    actor: user.id,
  });
  return NextResponse.json({ ok: true, archived: true, archived_at: c.archived_at, reason: reason || null });
});
