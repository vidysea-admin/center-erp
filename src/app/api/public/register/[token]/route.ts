import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { aadhaarError, canonicalAadhaar, canonicalPhone, emailError, phoneError } from "@/lib/validate";
import { BatchMember, Candidate, EDUCATION_LEVEL, Program, PublicToken } from "@/models";
// A-03: the ONE door every roster-add goes through (ARCHITECTURE.md 3.1) - this public link is the
// third caller and inherits Rule 20, the QA-945 future-interest gate and the joined-on rule from it.
import { addMemberChecked } from "@/lib/rules";
import { findDuplicateCandidates } from "@/lib/duplicates";
import { renderMail, sendMail } from "@/lib/mailer";
import { audit } from "@/lib/audit";

// Public candidate self-registration (2026-08-11: "मैंने आपको एक link भेज दिया, उस link पे
// आप अपनी detail भर दो"). No session — the per-location token in the URL is the credential.
// Guard rails: token must be active, honeypot field must be empty, per-IP rate limit.

async function loadToken(token: string) {
  const t = await PublicToken.findOne({ token, purpose: "register", active: true })
    .populate("location", "name city state operational_status")
    .populate("program", "name code")
    // A-03 (24-Aug sheet, Shiv, spoken): "Batch four ke liye main candidate ko self-registration ki
    // link bhej raha hoon... wo direct batch four mein hi assign ho jaana chahiye." The token has
    // carried a `batch` field since it was written - plan and attendance links use it - and the
    // register purpose never read it, so every self-registered candidate landed `Unassigned` and had
    // to be found and enrolled by hand. That is why AVP-GURU-RPLAVP-DST-04 sat at 0/41 enrolled.
    .populate({ path: "batch", select: "code status target_size planned_start program", populate: { path: "program", select: "name code" } })
    .lean<any>();
  if (!t) throw new HttpError(404, "This link is not valid or has been switched off.");
  return t;
}

// GET → what the form needs to render (location name, program choice)
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
  await dbConnect();
  const { token } = await ctx.params;
  const t = await loadToken(token);
  const programs = t.program
    ? [t.program]
    : await Program.find({ active: true }).select("name code").lean<any[]>();
  return NextResponse.json({
    location: { name: t.location?.name, city: t.location?.city, state: t.location?.state },
    programs,
    // 2026-08-24 (Umesh): the page cannot tell these two apart from `programs.length === 1` alone,
    // and they are not the same fact. "This link pins your programme" is a promise made to the
    // student; "the system happens to have one active programme today" is an accident that becomes
    // a silent free choice the moment somebody adds a second. Only the token knows which it is, so
    // the token says so rather than letting the screen guess.
    program_fixed: !!t.program,
    // A-03: when the link names a batch, the student is not choosing anything - not the programme
    // and not the intake. The form shows both, filled in and not editable, and the "current or a
    // future batch" question is dropped, because it cannot mean anything once the link has decided.
    // QA-1187: `full` is not a refusal - the student is still registered and still joins the roster,
    // exactly as a staff-added member would. It is here so the form can stop promising a seat it
    // cannot promise, which is what it was doing.
    batch: t.batch ? {
      code: t.batch.code, status: t.batch.status, planned_start: t.batch.planned_start,
      full: !!(t.batch.target_size && (await BatchMember.countDocuments({ batch: t.batch._id, left_on: null })) >= t.batch.target_size),
    } : null,
    batch_fixed: !!t.batch,
    education_levels: EDUCATION_LEVEL,
  });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
  await dbConnect();
  const { token } = await ctx.params;
  const t = await loadToken(token);
  rateLimit(clientKey(req), 10, 10 * 60_000); // audit auth S2-14: right-most trusted hop
  const body = await req.json();
  if (body.website) throw new HttpError(400, "Invalid submission."); // honeypot — bots fill every field

  const name = String(body.name ?? "").trim();
  if (!name) throw new HttpError(400, "Please enter your name.");
  // -126 (S18-04): this route used to re-implement both checks — `phone.length >= 10` and its own
  // email regex — while every other path in the product uses lib/validate. That is how "9999999999999"
  // got in through the public door and was refused everywhere else. Same rule everywhere now, and the
  // candidate reads the same sentence the staff form shows (QA-141's canon).
  const pErr = phoneError(body.phone);
  if (pErr) throw new HttpError(400, pErr);
  const phone = canonicalPhone(body.phone)!;
  // 15/08 (Umesh): phone AND email both mandatory on self-registration — the email
  // pipeline is coming, and everything should reach people properly by mail.
  const email = String(body.email ?? "").trim().toLowerCase();
  const eErr = emailError(email);
  if (eErr) throw new HttpError(400, eErr);
  const program = body.program && !t.program ? body.program : (t.program?._id ?? body.program);
  if (!program) throw new HttpError(400, "Please choose a program.");

  // 2026-08-24 (Umesh): Aadhaar on all three intake doors. Optional here, like every other government
  // field on this page — the person filling it is a student on a phone from a WhatsApp link, and a
  // longer REQUIRED form is a form they abandon (Umesh's own -126 ruling). But if they DO type one it
  // is checked, because a wrong Aadhaar collected here is discovered by the government portal weeks
  // later, when nobody remembers typing it.
  const aadhaarRaw = String(body.aadhaar_no ?? "").trim();
  if (aadhaarRaw) {
    const aErr = aadhaarError(aadhaarRaw, { optional: true });
    if (aErr) throw new HttpError(400, aErr);
  }

  const doc = await Candidate.create({
    name,
    phone,
    email,
    gender: body.gender || undefined,
    dob: body.dob ? new Date(body.dob) : undefined,
    education: EDUCATION_LEVEL.includes(body.education) ? body.education : undefined,
    last_training_date: body.last_training_date ? new Date(body.last_training_date) : undefined,
    // -126 (S18-02, Shivshakti): the government-portal fields the internal form has carried since
    // -116. They were never added here, so a candidate who self-registered still had to be chased for
    // exactly the data we built the fields to stop chasing. All optional — a blank one simply is not
    // written. Listed explicitly rather than spread from the body: this is an UNAUTHENTICATED door,
    // and the one thing it must never do is take whatever it is handed.
    ...Object.fromEntries((["salutation", "father_name", "mother_name", "marital_status", "religion",
      "social_category", "state", "district", "sub_district"] as const)
      .map((f) => [f, String(body[f] ?? "").trim() || undefined])),
    aadhaar_no: aadhaarRaw ? canonicalAadhaar(aadhaarRaw)! : undefined,
    // QA-945: the student says whether they want THIS intake or a later one. Anything other than the
    // literal "Future" falls back to the default - an unauthenticated door must never take a value it
    // did not offer, and the schema enum would otherwise refuse the whole registration over a typo.
    // A-03: a link that names a batch has already settled the intake, so the current-vs-future
    // question is not asked and cannot be answered. Forcing "Current" here is not ignoring the
    // student - the form does not offer them the choice on a batch-pinned link - and it matters
    // because `addMemberChecked` REFUSES a Future-interested candidate (QA-945). Leaving the field
    // free would let a stale or hand-edited request enrol nobody and say nothing about why.
    batch_interest: t.batch ? "Current" : (body.batch_interest === "Future" ? "Future" : "Current"),
    location: t.location._id,
    program,
    source: "Self Registration",
    lifecycle_status: "Unassigned",
  });
  await audit({ entity: "Candidate", entityId: doc._id, field: "create", newValue: `self-registered via public link (${t.location?.name}${t.batch ? `, batch ${t.batch.code}` : ""})`, actorType: "EXTERNAL_SYNC" });

  // A-03: and this is the half the ask was actually about - the registrant JOINS the batch the link
  // named, here, instead of being left on the pool for somebody to find.
  //
  // It goes through `addMemberChecked` rather than creating a BatchMember directly, deliberately:
  // ARCHITECTURE.md 3.1 records that the two existing roster-add doors already drifted apart once
  // (QA-273), and that anything deciding whether or how somebody joins belongs in that one function.
  // This is a THIRD door and it inherits every rule the other two obey - Rule 20, the QA-945 gate,
  // the joined-on date rule - for free, and cannot drift from them.
  //
  // A refusal here must never lose the registration. The candidate record is already written and the
  // student has done nothing wrong; a closed or full batch is the centre's problem, not theirs. So a
  // failed enrolment is recorded on the audit trail, in words, and the student is thanked exactly as
  // they would be on a centre-wide link. The team finds them on the pool, which is where every
  // self-registered candidate lived before this change anyway.
  let joinedBatch = null;
  if (t.batch) {
    if (["Completed", "Cancelled", "Closed"].includes(t.batch.status)) {
      await audit({ entity: "Candidate", entityId: doc._id, field: "batch_link_refused", actorType: "EXTERNAL_SYNC",
        newValue: `${t.batch.code} is ${t.batch.status} — the link still registered ${name}, but nobody can be enrolled into a finished batch. They are on the pool.` });
    } else {
      // QA-1187 — MY OWN CAPACITY CHECK IS GONE FROM HERE, and it was wrong in kind, not only in
      // place. This route used to refuse the join when the roster had reached target_size. The
      // product does not work that way and never did: `addMemberChecked` WARNS and admits
      // ("Roster is now N of target M — enrolment will be capped at M"), while Rule 48 in
      // `updateEnrollment` REFUSES only when somebody tries to COMPLETE enrolment past the target.
      // Joining a roster and being enrolled are two different events with two different rules, and
      // that is deliberate. My refusal invented a THIRD answer, on the one door a member of the
      // public uses — so an anonymous registrant was turned away from a roster a staff member could
      // have added them to.
      // The whole point of routing through addMemberChecked was to inherit its rules rather than
      // re-state them, and this was the one place I re-stated one anyway, one function away.
      // What was actually missing is not a refusal but the WARNING reaching somebody: it is carried
      // on the audit trail below, surfaced to the operator when the link is minted, and shown to the
      // student on the form. See QA-1187.
      {
        try {
          const m: any = await addMemberChecked(String(t.batch._id), String(doc._id));
          joinedBatch = t.batch.code;
          await audit({ entity: "Candidate", entityId: doc._id, field: "enrolled", actorType: "EXTERNAL_SYNC",
            newValue: `enrolled into ${t.batch.code} by the batch registration link${m?.warning ? ` — ${m.warning}` : ""}` });
        } catch (e: any) {
          await audit({ entity: "Candidate", entityId: doc._id, field: "batch_link_refused", actorType: "EXTERNAL_SYNC",
            newValue: `${t.batch.code}: ${e?.message ?? "enrolment refused"} — ${name} is registered and on the pool.` });
        }
      }
    }
  }
  // Advisory duplicate note for the team, never surfaced to the candidate.
  const dups = await findDuplicateCandidates({ phone, name, dob: doc.dob }, String(doc._id)).catch(() => []);
  if (dups.length) {
    await audit({ entity: "Candidate", entityId: doc._id, field: "duplicate_check", newValue: `${dups.length} possible duplicate(s) at intake`, actorType: "SYSTEM" });
  }
  // QA-115: the mandatory address gets its first real use — a confirmation the candidate
  // can keep. Fire-and-forget; registration never fails on mail.
  {
    const { html, text } = renderMail({
      title: "Your training registration is received",
      lines: [`Hello ${name},`, `Your details are registered with ${t.location?.name ?? "the training centre"}. The team will contact you about the next steps.`, `Keep this email as your registration confirmation.`],
    });
    sendMail({ to: email, subject: "Your training registration is received", html, text, entity: "Candidate", entity_id: doc._id }).catch(() => {});
  }
  // QA-1239: the second half of the same finding. When a batch-pinned link could NOT seat them,
  // the refusal used to reach the audit trail and nobody else - the student got the same
  // "Thank you! Your details are registered" as somebody who had just been put on a roster. They
  // opened a link that named a batch, so the one thing they will want to know is whether they are
  // on it. This does not blame them and does not name the batch's internal state; it says what
  // happened and who will be in touch.
  const batchMissed = !!t.batch && !joinedBatch;
  return NextResponse.json({ ok: true, batch: joinedBatch,
    message: joinedBatch
      ? `Thank you! Your details are registered and you are on batch ${joinedBatch}. The team will contact you about the next steps.`
      : batchMissed
        ? "Thank you! Your details are registered. This batch could not take a new registration, so the centre will contact you about the next one."
        : "Thank you! Your details are registered — the team will contact you." }, { status: 201 });
});
