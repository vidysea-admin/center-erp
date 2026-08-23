import { collectionRoutes } from "@/lib/crud";
import { BatchMember, Candidate, CandidateResult, Location, Program } from "@/models";
import { assertLocationInScope, HttpError, isScoped } from "@/lib/authz";
import { looksLikeCan } from "@/lib/govt-attendance";
import { emailError, canonicalPhone, phoneError } from "@/lib/validate";
import { candidateEligibility } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { renderMail, sendMail } from "@/lib/mailer";
import { sendSms } from "@/lib/sms";

export const { GET, POST } = collectionRoutes({
  model: Candidate, entity: "Candidate",
  fields: ["name", "phone", "alt_phone", "email", "gender", "dob", "id_reference", "location", "program", "source", "lifecycle_status", "education", "last_training_date", "interested_programs", "interested_locations", "sidh_status", "sidh_link_sent_at", "sidh_registered_on", "sidh_candidate_id", "sidh_failure_reason", "fee_amount", "fee_paid_on", "fee_reference",
    // -116 (SS-01): the government portal's own fields, so the data is typed once rather than chased.
    "salutation", "father_name", "mother_name", "marital_status", "religion", "social_category", "state", "district", "sub_district",
    // -126 (S18-03): address_type and differently_abled removed — they were never in his spoken list
    // of eight, and he asked for them back out.
    // -134 (QA-283): the human-applied "documents were done on SIDH" mark. On BOTH doors — a field
    // the item route does not accept looks saved and is gone on the next read (the -116 lesson).
    "sidh_docs_verified",
  ],
  // 2026-08-13 (Umesh: "search should allow all the columns"): the global shell search
  // rides this too — alt numbers, mobiliser/campaign and the portal CAN_ id all findable.
  searchFields: ["name", "phone", "alt_phone", "source", "sidh_candidate_id"],
  // QA-060/095 (CEO [38:43] "I shouldn't see all the candidates … just my batch-wise
  // details"): a Trainer never reads the centre's candidate pool — their lens is the
  // batch roster and the Attendance tab, which stay open to them.
  readRoles: ["Admin", "Operations", "Location", "Enrollment"],
  writeRoles: ["Admin", "Operations", "Location", "Enrollment"],
  permission: "candidates.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
  ],
  // Rule 38: creating a record at someone else's location was previously unchecked.
  beforeCreate(data, user) {
    // -156 (QA-450): a blank portal ID is the ABSENCE of an identity, and "" is a string, so the
    // QA-417 partial unique index indexed it and the SECOND person saved with a blank field was
    // told "That sidh candidate id is already in use." - naming a duplicate identity that does not
    // exist. The Excel writer and sheet-sync already store absent; this is the door that did not,
    // and it is the door the drawer's Add form posts through (type-then-clear reproduces it).
    if (typeof data.sidh_candidate_id === "string" && !data.sidh_candidate_id.trim()) delete data.sidh_candidate_id;
    // QA-714 (-210): the same shape check the item door applies - one definition, imported by both
    // (QA-728). An id every reader parses with normalizeCan but no writer validated is the shape
    // that let "40918461" save, audit as a change, and leave the student blocked with nothing on
    // screen saying why.
    //
    // QA-727 (-212, checker on qa-210): the comment that used to sit here said "the bulk import
    // keeps its own normalize-and-report lane; this is the hand-typed door." There was no such lane
    // for this field - the importer wrote any string verbatim and normalizeCan was not even imported
    // into that file. The excuse named a safeguard that did not exist, on the door the code itself
    // calls how rosters actually arrive. The importer now reports the field per row, the way it has
    // always reported phone; this door still REFUSES, because a hand-typed id has a human at the
    // keyboard who can be told.
    if (typeof data.sidh_candidate_id === "string" && data.sidh_candidate_id.trim() && !looksLikeCan(data.sidh_candidate_id)) {
      throw new HttpError(400, `"${data.sidh_candidate_id.trim()}" is not a portal Candidate ID. It reads like CAN_12345678 - the letters CAN followed by the number. Copy it from SIDH exactly as it appears there.`);
    }
    // QA-730: store what was validated, without the whitespace the partial unique index would miss.
    if (typeof data.sidh_candidate_id === "string") data.sidh_candidate_id = data.sidh_candidate_id.trim();
    // QA-141 (Umesh): manual entry is strict; bulk import keeps its own normalize-and-report
    // lane (rows are client data and are never dropped over format).
    const pErr = phoneError(data.phone);
    if (pErr) throw new HttpError(400, pErr);
    data.phone = canonicalPhone(data.phone)!;
    if (data.alt_phone) {
      const aErr = phoneError(data.alt_phone, { optional: true });
      if (aErr) throw new HttpError(400, "Alt phone: " + aErr);
      data.alt_phone = canonicalPhone(data.alt_phone)!;
    }
    const eErr = emailError(data.email, { optional: true });
    if (eErr) throw new HttpError(400, eErr);
    if (data.location) assertLocationInScope(user, String(data.location));
    // -124 (M4-04): the centre is optional now — but only for someone who can see every centre.
    // QA-125's reasoning holds: a scoped user creating an unplaced row would create a person their
    // own list can never show them, and Rule 38 scoping keys on exactly this field.
    if (!data.location && isScoped(user)) {
      throw new HttpError(400, "Choose the centre this candidate belongs to. (A candidate can be entered without one, but only by Admin or Operations — they get their centre when they are enrolled on a batch.)");
    }
  },
  // -109 (Umesh 17/08): "admin ne new student register kiya, new student ko mail nahi aaya — check
  // karo." Confirmed and precise: there were NINE places that send mail and none of them was this
  // one. Every registration mail lived on the PUBLIC paths (self-registration, token link, trainer
  // apply); a student entered from inside the ERP got nothing, because the moment was never built —
  // not a broken transport (SES is live and sending).
  //
  // Fire-and-forget, exactly like the public path: creating a candidate must never fail on mail.
  // A candidate with no email is not an error — phone is the required field and most rows are
  // phone-only — and sendMail already records that honestly as "skipped: no valid recipient
  // address" in MailLog, so "did it go?" stays answerable per candidate either way.
  // Umesh also asked for an SMS fallback where there is no email; that needs a provider and its
  // credentials, so it is raised separately rather than half-built here.
  async afterWrite(doc, user) {
    const [loc, prog] = await Promise.all([
      Location.findById(doc.location).select("name").lean<any>().catch(() => null),
      Program.findById(doc.program).select("name").lean<any>().catch(() => null),
    ]);
    // -110 (Umesh 17/08: "mail id hai toh mail pe jaye, otherwise phone pe jaye"): the SMS arm.
    // Fires only when there is NO email — a student with an address gets the mail below. It is
    // switched off by construction until Umesh gets this purpose's DLT template approved
    // (ENABLEX_SMS_TEMPLATE_REGISTRATION unset → sendSms records "skipped: no approved DLT
    // template"), so the row exists and never claims a send that could not happen.
    if (!doc?.email) {
      sendSms({
        to: doc?.phone, purpose: "registration",
        values: { name: String(doc?.name ?? ""), program: prog?.name ?? "training", centre: loc?.name ?? "our training centre" },
        entity: "Candidate", entity_id: doc?._id,
      }).catch(() => {});
      return;
    }
    const { html, text } = renderMail({
      title: "Your training registration is received",
      lines: [
        `Hello ${doc.name},`,
        `You have been registered for ${prog?.name ?? "training"} at ${loc?.name ?? "our training centre"}. The team will contact you about the next steps.`,
        `Keep this email as your registration confirmation. Registered by ${user.name}.`,
      ],
    });
    sendMail({ to: doc.email, subject: "Your training registration is received", html, text, entity: "Candidate", entity_id: doc._id }).catch(() => {});
  },
  // 2026-08-11: eligibility (age / education / training cooldown) computed on read,
  // never stored — it flips on its own as the cooldown lapses.
  // 2026-08-13 (Umesh: "enrolled hai to No programme kyun?"): a candidate sitting in a batch
  // effectively HAS that batch's programme even when the imported row never carried one —
  // attach the active membership (at most one: partial-unique index on {candidate, left_on:null})
  // so the list can show the real programme instead of a false "No programme".
  async mapItems(items) {
    const defaults = await getDefaults();
    const members = await BatchMember.find({ candidate: { $in: items.map((c) => c._id) }, left_on: null })
      .select("candidate batch")
      .populate({ path: "batch", select: "code program status", populate: { path: "program", select: "name code scheme" } })
      .lean();
    const byCand = new Map(members.map((m: any) => [String(m.candidate), m.batch]));
    // QA-069 (S1): the Enrolled journey read "Result Awaited" for people whose result WAS
    // recorded — the journey trusted lifecycle_status, which historical imports never
    // caught up. The recorded assessment is the truth; it rides on every row as
    // latest_result and the journey derives from it first.
    const results = await CandidateResult.find({ candidate: { $in: items.map((c) => c._id) }, result: { $ne: "Pending" } })
      .select("candidate result assessed_on").sort({ assessed_on: -1, updatedAt: -1 }).lean<any[]>();
    const resByCand = new Map<string, string>();
    for (const r of results) if (!resByCand.has(String(r.candidate))) resByCand.set(String(r.candidate), r.result);
    return items.map((c) => {
      const b: any = byCand.get(String(c._id));
      return {
        ...c, eligibility: candidateEligibility(c, defaults),
        active_batch: b ? { code: b.code, status: b.status, program: b.program } : null,
        latest_result: resByCand.get(String(c._id)) ?? null,
      };
    });
  },
});
