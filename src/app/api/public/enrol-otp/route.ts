import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { rateLimit, clientKey, phoneChallengeGate } from "@/lib/rate-limit";
import { Candidate, EDUCATION_LEVEL, Location, Notification, Program, PublicToken } from "@/models";
import { aadhaarError, canonicalAadhaar, canonicalPhone, emailError, phoneError } from "@/lib/validate";
import { findDuplicateCandidates } from "@/lib/duplicates";
import { renderMail, sendMail } from "@/lib/mailer";
import { sendSms, smsTemplateFor } from "@/lib/sms";
import { audit } from "@/lib/audit";

// QA-116 (CEO's "one of the two" enrolment paths — the OTP route; Umesh 16/08: email-OTP,
// mail is live). A walk-in candidate with NO link proves they own an email address, then
// registers through the same field set the link path uses. This is INTAKE, not
// record-claiming — the OTP verifies the email being registered, never unlocks an existing
// row. Guard rails mirror trainer-apply: honeypot, per-IP rate limits, hash-only OTP
// storage, 10-minute expiry, 5 wrong attempts burn the challenge.
//
// -110 (Umesh 17/08, checker QA-188): the SAME challenge over SMS. A walk-in student with a phone
// and no email proves they own the number instead. Everything above is reused verbatim — the only
// place the phone path is STRICTER is rate limiting: an SMS costs money and reaches a real phone, so
// per-IP limits alone make this an SMS-pumping target. See phoneChallengeGate in lib/rate-limit.ts.
// The OTP goes out on the ONE DLT template approved on the EnableX account (888579131). Its var1 is
// a name and a name is not known before registration, so it is filled with "Student" — the text is
// exactly the approved wording, which is what the gateway checks; the variable is ours to fill.

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// GET ?token= → the registration form's context, only after the OTP is verified.
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const t = await PublicToken.findOne({ token, purpose: { $in: ["email_otp", "phone_otp"] }, active: true, otp_verified: true }).lean<any>();
  if (!t) throw new HttpError(404, "This code session is not valid — request a new code.");
  const [locations, programs] = await Promise.all([
    Location.find({ operational_status: { $nin: ["On Hold", "Stopped", "Closed"] } }).select("name city state").sort({ name: 1 }).lean(),
    Program.find({ active: true }).select("name code scheme").sort({ name: 1 }).lean(),
  ]);
  return NextResponse.json({ email: t.email ?? null, phone: t.phone ?? null, channel: t.purpose === "phone_otp" ? "sms" : "email", locations, programs, education_levels: EDUCATION_LEVEL });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const body = await req.json();
  if (body.website) throw new HttpError(400, "Invalid submission."); // honeypot
  const action = String(body.action ?? "");

  if (action === "request") {
    // ---- -110: the SMS branch. Same challenge, stricter gates (money leaves on every code).
    // Its per-IP bucket is its OWN ("otp-sms:") — the two channels do not share the 5/hour/IP
    // allowance, so a student who tried email first is not locked out of SMS, and the toll-fraud
    // gates below are the ones that actually protect the money.
    if (body.phone && !body.email) {
      rateLimit("otp-sms:" + clientKey(req), 5, 60 * 60_000); // 5 SMS codes/hour/IP
      const pErr = phoneError(body.phone);
      if (pErr) throw new HttpError(400, pErr);
      const phone = canonicalPhone(body.phone)!;
      const gate = phoneChallengeGate(phone);
      if (!gate.ok) {
        if (gate.reason === "daily_cap") {
          // A silent stop is how the bill and the outage are both found a day late — say it to a human.
          await Notification.create({
            type: "sms_daily_cap", severity: "warning",
            message: `SMS daily cap reached (${process.env.SMS_DAILY_CAP ?? 500}) — OTP sending paused until the window resets. Raise SMS_DAILY_CAP if this is legitimate volume.`,
            entity: "System", role_target: ["Admin", "Operations"],
          }).catch(() => {});
          throw new HttpError(429, "SMS sending is paused for today — please try again later or contact the centre.");
        }
        throw new HttpError(429, gate.reason === "cooldown"
          ? `Please wait ${gate.retryAfterSec ?? 60} seconds before requesting another code.`
          : "Too many codes sent to this number — please try again later.");
      }
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const token = crypto.randomBytes(16).toString("hex");
      await PublicToken.updateMany({ purpose: "phone_otp", phone, active: true }, { $set: { active: false } });
      await PublicToken.create({
        token, purpose: "phone_otp", phone,
        otp_hash: sha(code), otp_expires_at: new Date(Date.now() + 10 * 60_000), otp_attempts: 0,
      });
      // The template's var1 is a name; there is none yet. "Student" keeps the approved text intact.
      // The code is never written to the log (QA-142 — the Admin panel must not be a live-codes list).
      sendSms({ to: phone, purpose: "otp", values: { name: "Student", code }, log_preview: "OTP for verification is ****** (template 888579131)", entity: "PublicToken" }).catch(() => {});
      return NextResponse.json({ ok: true, token, channel: "sms", message: smsTemplateFor("otp")
        ? "If the number is reachable, a 6-digit code is on its way by SMS."
        : "SMS codes are not switched on yet — please register by email, or ask the centre." });
    }

    rateLimit("otp-req:" + clientKey(req), 5, 60 * 60_000); // 5 email codes/hour/IP (unchanged)
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
    const t = await PublicToken.findOne({ token: String(body.token ?? ""), purpose: { $in: ["email_otp", "phone_otp"] }, active: true });
    if (!t) throw new HttpError(404, "This code session is not valid — request a new code.");
    if (t.otp_expires_at && t.otp_expires_at < new Date()) { t.active = false; await t.save(); throw new HttpError(400, "That code has expired — request a new one."); }
    if ((t.otp_attempts ?? 0) >= 5) { t.active = false; await t.save(); throw new HttpError(400, "Too many wrong tries — request a new code."); }
    if (sha(String(body.code ?? "")) !== t.otp_hash) {
      t.otp_attempts = (t.otp_attempts ?? 0) + 1;
      await t.save();
      throw new HttpError(400, t.purpose === "phone_otp" ? "That code is not right — check the SMS and try again." : "That code is not right — check the mail and try again.");
    }
    t.otp_verified = true;
    await t.save();
    return NextResponse.json({ ok: true });
  }

  if (action === "register") {
    rateLimit("otp-reg:" + clientKey(req), 10, 60 * 60_000);
    const t = await PublicToken.findOne({ token: String(body.token ?? ""), purpose: { $in: ["email_otp", "phone_otp"] }, active: true, otp_verified: true });
    if (!t) throw new HttpError(404, "This code session is not valid — request a new code.");
    const name = String(body.name ?? "").trim();
    if (!name) throw new HttpError(400, "Name is required.");
    // -110: on the SMS path the VERIFIED number is the phone of record — never a typed-in one, the
    // exact rule the email path already applies to the address. On the email path the phone is typed
    // and validated strictly (QA-141) because nobody has proved they own it.
    let phone: string;
    if (t.purpose === "phone_otp") {
      phone = String(t.phone);
    } else {
      const pErr = phoneError(body.phone); // QA-141: strict — the candidate is right here to fix it
      if (pErr) throw new HttpError(400, pErr);
      phone = canonicalPhone(body.phone)!;
    }
    if (!body.location) throw new HttpError(400, "Please choose your training centre.");
    if (!body.program) throw new HttpError(400, "Please choose a program.");
    const loc = await Location.findById(body.location).select("name operational_status").lean<any>();
    if (!loc || ["On Hold", "Stopped", "Closed"].includes(String(loc.operational_status))) {
      throw new HttpError(400, "That centre is not taking registrations right now.");
    }
    // 2026-08-24 (Umesh): Aadhaar on the OTP door too. -130/QA-275 is the standing lesson about this
    // exact page: the nine Skill India fields went onto p/register and both internal routes and
    // stopped there, so a student arriving through THIS link still had to be chased for the data the
    // fields exist to stop chasing. Optional, validated when supplied.
    const aadhaarRaw = String((body as any).aadhaar_no ?? "").trim();
    if (aadhaarRaw) {
      const aErr = aadhaarError(aadhaarRaw, { optional: true });
      if (aErr) throw new HttpError(400, aErr);
    }
    const doc = await Candidate.create({
      name, phone,
      aadhaar_no: aadhaarRaw ? canonicalAadhaar(aadhaarRaw)! : undefined,
      email: t.purpose === "phone_otp" ? (body.email ? String(body.email).trim().toLowerCase() : undefined) : t.email, // the VERIFIED address on the email path, never a typed-in one
      gender: body.gender || undefined,
      dob: body.dob ? new Date(body.dob) : undefined,
      education: EDUCATION_LEVEL.includes(body.education) ? body.education : undefined,
      last_training_date: body.last_training_date ? new Date(body.last_training_date) : undefined,
      // -130 (QA-275): the nine Skill India fields. -126 put them on p/register and on both internal
      // routes and stopped there — and p/enrol is the OTP walk-in link, a different link for the
      // same job, so a student arriving through it still had to be chased for exactly the data the
      // fields exist to stop chasing. The checker's own note on passing QA-261: "I checked the door
      // the row named and did not ask whether the product had another one." Listed explicitly rather
      // than spread from the body — this is an UNAUTHENTICATED door, and the one thing it must never
      // do is take whatever it is handed.
      ...Object.fromEntries((["salutation", "father_name", "mother_name", "marital_status", "religion",
        "social_category", "state", "district", "sub_district"] as const)
        .map((f) => [f, String((body as any)[f] ?? "").trim() || undefined])),
      location: t.location ?? body.location,
      program: body.program,
      source: t.purpose === "phone_otp" ? "Self Registration (SMS OTP)" : "Self Registration (OTP)",
      lifecycle_status: "Unassigned",
    });
    t.active = false; // single use
    await t.save();
    await audit({ entity: "Candidate", entityId: doc._id, field: "create", newValue: `self-registered via ${t.purpose === "phone_otp" ? "SMS" : "email"} OTP (${loc.name})`, actorType: "EXTERNAL_SYNC" });
    const dups = await findDuplicateCandidates({ phone, name, dob: doc.dob }, String(doc._id)).catch(() => []);
    if (dups.length) {
      await audit({ entity: "Candidate", entityId: doc._id, field: "duplicate_check", newValue: `${dups.length} possible duplicate(s) at intake`, actorType: "SYSTEM" });
    }
    const { html, text } = renderMail({
      title: "Your training registration is received",
      lines: [`Hello ${name},`, `Your details are registered with ${loc.name}. The team will contact you about the next steps.`, `Keep this email as your registration confirmation.`],
    });
    sendMail({ to: doc.email ?? "", subject: "Your training registration is received", html, text, entity: "Candidate", entity_id: doc._id }).catch(() => {});
    return NextResponse.json({ ok: true, message: "Thank you! Your details are registered — the team will contact you." }, { status: 201 });
  }

  throw new HttpError(400, "Unknown action.");
});
