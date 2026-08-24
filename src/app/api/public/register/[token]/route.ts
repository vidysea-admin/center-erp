import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { canonicalPhone, emailError, phoneError } from "@/lib/validate";
import { Candidate, EDUCATION_LEVEL, Program, PublicToken } from "@/models";
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
    location: t.location._id,
    program,
    source: "Self Registration",
    lifecycle_status: "Unassigned",
  });
  await audit({ entity: "Candidate", entityId: doc._id, field: "create", newValue: `self-registered via public link (${t.location?.name})`, actorType: "EXTERNAL_SYNC" });
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
  return NextResponse.json({ ok: true, message: "Thank you! Your details are registered — the team will contact you." }, { status: 201 });
});
