import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { Candidate, EDUCATION_LEVEL, Location, Program, PublicToken } from "@/models";
import { canonicalPhone, emailError, phoneError } from "@/lib/validate";
import { findDuplicateCandidates } from "@/lib/duplicates";
import { renderMail, sendMail } from "@/lib/mailer";
import { audit } from "@/lib/audit";

// QA-116 (CEO's "one of the two" enrolment paths — the OTP route; Umesh 16/08: email-OTP,
// mail is live). A walk-in candidate with NO link proves they own an email address, then
// registers through the same field set the link path uses. This is INTAKE, not
// record-claiming — the OTP verifies the email being registered, never unlocks an existing
// row. Guard rails mirror trainer-apply: honeypot, per-IP rate limits, hash-only OTP
// storage, 10-minute expiry, 5 wrong attempts burn the challenge.

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// GET ?token= → the registration form's context, only after the OTP is verified.
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const t = await PublicToken.findOne({ token, purpose: "email_otp", active: true, otp_verified: true }).lean<any>();
  if (!t) throw new HttpError(404, "This code session is not valid — request a new code.");
  const [locations, programs] = await Promise.all([
    Location.find({ operational_status: { $nin: ["On Hold", "Stopped", "Closed"] } }).select("name city state").sort({ name: 1 }).lean(),
    Program.find({ active: true }).select("name code scheme").sort({ name: 1 }).lean(),
  ]);
  return NextResponse.json({ email: t.email, locations, programs, education_levels: EDUCATION_LEVEL });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const body = await req.json();
  if (body.website) throw new HttpError(400, "Invalid submission."); // honeypot
  const action = String(body.action ?? "");

  if (action === "request") {
    rateLimit("otp-req:" + clientKey(req), 5, 60 * 60_000); // 5 codes/hour/IP
    const email = String(body.email ?? "").trim().toLowerCase();
    const eErr = emailError(email);
    if (eErr) throw new HttpError(400, eErr);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const token = crypto.randomBytes(16).toString("hex");
    // One live challenge per email — a new request burns the old one.
    await PublicToken.updateMany({ purpose: "email_otp", email, active: true }, { $set: { active: false } });
    await PublicToken.create({
      token, purpose: "email_otp", email,
      otp_hash: sha(code), otp_expires_at: new Date(Date.now() + 10 * 60_000), otp_attempts: 0,
    });
    const { html, text } = renderMail({
      title: "Your registration code",
      lines: [`Your one-time code is:`, code, `It works for 10 minutes. If you did not ask for this, ignore this mail.`],
    });
    // QA-142: the code stays in the REAL subject (phone notification preview) but never in
    // the log — the Admin mail panel must not be a live-codes list.
    sendMail({ to: email, subject: `${code} is your registration code`, log_subject: "****** is your registration code", html, text, entity: "PublicToken" }).catch(() => {});
    return NextResponse.json({ ok: true, token, message: "If the address is reachable, a 6-digit code is on its way." });
  }

  if (action === "verify") {
    rateLimit("otp-ver:" + clientKey(req), 20, 60 * 60_000);
    const t = await PublicToken.findOne({ token: String(body.token ?? ""), purpose: "email_otp", active: true });
    if (!t) throw new HttpError(404, "This code session is not valid — request a new code.");
    if (t.otp_expires_at && t.otp_expires_at < new Date()) { t.active = false; await t.save(); throw new HttpError(400, "That code has expired — request a new one."); }
    if ((t.otp_attempts ?? 0) >= 5) { t.active = false; await t.save(); throw new HttpError(400, "Too many wrong tries — request a new code."); }
    if (sha(String(body.code ?? "")) !== t.otp_hash) {
      t.otp_attempts = (t.otp_attempts ?? 0) + 1;
      await t.save();
      throw new HttpError(400, "That code is not right — check the mail and try again.");
    }
    t.otp_verified = true;
    await t.save();
    return NextResponse.json({ ok: true });
  }

  if (action === "register") {
    rateLimit("otp-reg:" + clientKey(req), 10, 60 * 60_000);
    const t = await PublicToken.findOne({ token: String(body.token ?? ""), purpose: "email_otp", active: true, otp_verified: true });
    if (!t) throw new HttpError(404, "This code session is not valid — request a new code.");
    const name = String(body.name ?? "").trim();
    const pErr = phoneError(body.phone); // QA-141: strict — the candidate is right here to fix it
    if (!name || pErr) throw new HttpError(400, pErr ?? "Name is required.");
    const phone = canonicalPhone(body.phone)!;
    if (!body.location) throw new HttpError(400, "Please choose your training centre.");
    if (!body.program) throw new HttpError(400, "Please choose a program.");
    const loc = await Location.findById(body.location).select("name operational_status").lean<any>();
    if (!loc || ["On Hold", "Stopped", "Closed"].includes(String(loc.operational_status))) {
      throw new HttpError(400, "That centre is not taking registrations right now.");
    }
    const doc = await Candidate.create({
      name, phone,
      email: t.email, // the VERIFIED address, never a typed-in one
      gender: body.gender || undefined,
      dob: body.dob ? new Date(body.dob) : undefined,
      education: EDUCATION_LEVEL.includes(body.education) ? body.education : undefined,
      last_training_date: body.last_training_date ? new Date(body.last_training_date) : undefined,
      location: t.location ?? body.location,
      program: body.program,
      source: "Self Registration (OTP)",
      lifecycle_status: "Unassigned",
    });
    t.active = false; // single use
    await t.save();
    await audit({ entity: "Candidate", entityId: doc._id, field: "create", newValue: `self-registered via email OTP (${loc.name})`, actorType: "EXTERNAL_SYNC" });
    const dups = await findDuplicateCandidates({ phone, name, dob: doc.dob }, String(doc._id)).catch(() => []);
    if (dups.length) {
      await audit({ entity: "Candidate", entityId: doc._id, field: "duplicate_check", newValue: `${dups.length} possible duplicate(s) at intake`, actorType: "SYSTEM" });
    }
    const { html, text } = renderMail({
      title: "Your training registration is received",
      lines: [`Hello ${name},`, `Your details are registered with ${loc.name}. The team will contact you about the next steps.`, `Keep this email as your registration confirmation.`],
    });
    sendMail({ to: t.email, subject: "Your training registration is received", html, text, entity: "Candidate", entity_id: doc._id }).catch(() => {});
    return NextResponse.json({ ok: true, message: "Thank you! Your details are registered — the team will contact you." }, { status: 201 });
  }

  throw new HttpError(400, "Unknown action.");
});
