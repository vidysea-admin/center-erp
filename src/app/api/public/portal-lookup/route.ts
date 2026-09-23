import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError, readJson } from "@/lib/authz";
import { BatchMember, Candidate, Notification, PublicToken } from "@/models";
import { clientKey, rateLimit, phoneChallengeGate, emailChallengeGate } from "@/lib/rate-limit";
import { sendSms, smsTemplateFor } from "@/lib/sms";
import { renderMail, sendMail } from "@/lib/mailer";

// 2026-08-13 (Umesh: "candidate ke liye bhi ek hoga — ye requirement hai"): the /p/me entry
// point. A candidate types the mobile number they registered with and lands on their own
// "My Training" page (the per-member attendance capability link).
//
// Trust model: the WhatsApp/SMS distribution of these links already treats possession of the
// registered phone as the credential. Typing a number does NOT prove possession, so a second
// factor is always demanded before any token is minted:
//   - DOB on file  → the DOB is the second factor, checked in ONE step (unchanged, QA-056 IST).
//   - NO DOB       → qa-2809 (Umesh, 2026-09-22 "phone and otp ho"; 2026-09-23 "mail + otp de doo,
//                    mail tho jayega hi naa"): a one-time code is the second factor. The old
//                    behaviour minted a PublicToken on the last 10 digits of a phone number ALONE,
//                    which is possession of a number the caller only TYPED. Now a code is sent to a
//                    contact ON FILE and must be verified (action:"verify-otp") before
//                    completeLookup() runs. CHANNEL SELECTION: EMAIL is primary — SES is live in
//                    production today, so a DOB-less candidate WITH an email self-serves NOW; SMS is
//                    the fallback for candidates with no email (works only once EnableX is switched
//                    on); a candidate with NEITHER still falls to the centre-coordinator dead-end.
//                    Both channels reuse the SAME challenge apparatus (hash-only storage, 10-min
//                    expiry, 5-attempt burn; email uses emailChallengeGate, SMS phoneChallengeGate)
//                    on a distinct purpose "attendance_otp" so an attendance session token can never
//                    be replayed at the registration door. The contact is read off the MATCHED
//                    record, never typed — a typed address/number proves nothing.
// Every failure is the SAME generic message so the endpoint neither confirms nor denies that a
// number is known (beyond what a DOB-less lookup already revealed by responding at all). Per-IP
// rate-limited; the SMS send is additionally gated per-phone.

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();

  const body = await readJson(req).catch(() => ({}));
  const action = String(body.action ?? "");

  // QA-057: the refusal stays GENERIC on purpose (anti-enumeration — it never confirms a
  // number is known), but it names the second field, because with 504 of 590 candidates
  // carrying a DOB the old wording read as "wrong number" to the majority.
  const fail = () => new HttpError(404, "These details did not match. Check the mobile number — and if you have a date of birth on record, enter that too. Your centre coordinator can also send you your link.");

  // Shared tail: turn an ALREADY-AUTHENTICATED candidate into a My Training url (or pool status).
  // Reached by the DOB single-step path AND by the DOB-less path only AFTER its OTP is verified —
  // this is the ONLY place a purpose:"attendance" PublicToken is minted on this route.
  const completeLookup = async (cand: any) => {
    // At most one active membership (partial-unique index on {candidate, left_on: null}).
    const member = await BatchMember.findOne({ candidate: cand._id, left_on: null }).select("_id batch").lean<any>();
    if (!member) {
      // Real candidate, no batch yet — say where they stand instead of a dead end.
      return NextResponse.json({
        enrolled: false,
        name: String(cand.name ?? "").split(" ")[0],
        sidh_status: cand.sidh_status ?? "Not Registered",
        lifecycle_status: cand.lifecycle_status ?? "Unassigned",
      });
    }
    const existing = await PublicToken.findOne({ purpose: "attendance", batch_member: member._id, active: true }).lean<any>();
    const token = existing?.token ?? (await PublicToken.create({
      purpose: "attendance", batch: member.batch, batch_member: member._id,
      token: crypto.randomBytes(16).toString("hex"), active: true,
    })).token;
    return NextResponse.json({ enrolled: true, url: `/p/attendance/${token}` });
  };

  // ---- Step 2 (DOB-less path only): verify the phone OTP, THEN mint. ----
  // qa-2809: nothing on this route mints a purpose:"attendance" token until a correct, unexpired,
  // within-attempt-limit OTP has been verified here. The DOB path never sends "verify-otp".
  if (action === "verify-otp") {
    rateLimit(`portal-otp-verify:${clientKey(req)}`, 20, 60_000);
    const t = await PublicToken.findOne({ token: String(body.otp_token ?? ""), purpose: "attendance_otp", active: true });
    if (!t) throw new HttpError(404, "This code session is not valid — request a new code.");
    if (t.otp_expires_at && t.otp_expires_at < new Date()) { t.active = false; await t.save(); throw new HttpError(400, "That code has expired — request a new one."); }
    if ((t.otp_attempts ?? 0) >= 5) { t.active = false; await t.save(); throw new HttpError(400, "Too many wrong tries — request a new code."); }
    if (sha(String(body.code ?? "")) !== t.otp_hash) {
      t.otp_attempts = (t.otp_attempts ?? 0) + 1;
      await t.save();
      // qa-2809 email channel: point the caller at the right inbox. The token carries `email` only
      // when the code was mailed; otherwise it went by SMS.
      throw new HttpError(400, t.email
        ? "That code is not right — check the mail and try again."
        : "That code is not right — check the SMS and try again.");
    }
    t.active = false; // single use
    await t.save();
    // Re-resolve the candidate from the phone stored ON THE TOKEN — never a caller-supplied one, and
    // works for BOTH channels: the email token stores the same on-file phone (a DOB-less candidate on
    // this door was matched by phone in step 1, so one always exists). qa-2809 keeps this channel-
    // agnostic rather than adding a candidate column the schema does not have (all changes stay in
    // this route; attendance_otp is unchanged).
    const cand = await Candidate.findOne({ phone: { $regex: String(t.phone ?? "") + "$" } }).select("name dob sidh_status lifecycle_status").lean<any>();
    if (!cand) throw fail();
    return completeLookup(cand);
  }

  // ---- Step 1 (default): identify the candidate. ----
  rateLimit(`portal-lookup:${clientKey(req)}`, 10, 60_000);
  const phone = String(body.phone ?? "").replace(/\D/g, "").slice(-10);
  const dob = String(body.dob ?? "").trim(); // yyyy-mm-dd from the date input
  if (phone.length !== 10) throw fail();
  const cand = await Candidate.findOne({ phone: { $regex: phone + "$" } }).select("name dob phone email sidh_status lifecycle_status").lean<any>();
  if (!cand) throw fail();

  if (cand.dob) {
    // QA-056 (S1, checker): DOBs imported at IST midnight are stored as the PREVIOUS day
    // 18:30 UTC, and a UTC .toISOString() comparison locked every such student out — their
    // real birthday 404'd, the day before it worked. Both sides now canonicalize to the
    // IST calendar date (+05:30) before comparing, which also leaves clean UTC-midnight
    // dates (API-created rows) matching exactly as before.
    const istDateKey = (d: string | Date) => {
      const x = new Date(d);
      x.setMinutes(x.getMinutes() + 330);
      return x.toISOString().slice(0, 10);
    };
    if (!dob || istDateKey(dob) !== istDateKey(cand.dob)) throw fail();
    return completeLookup(cand); // DOB was the second factor — mint in one step, unchanged.
  }

  // ---- DOB-LESS PATH (qa-2809, Umesh "phone and otp ho" + "mail + otp de doo"): phone alone NO
  // LONGER mints. ---- Instead of completeLookup(), send a one-time code to a contact ON FILE and
  // return an "OTP sent" state. Every branch below RETURNS without minting, so possession of a typed
  // number cannot open the page. QA-056 stays respected — DOB is never required; it is simply absent
  // for these rows. The code + token are minted once and used by whichever channel wins.
  const otpPhone = (String(cand.phone ?? "").replace(/\D/g, "").slice(-10)) || phone;
  const email = String(cand.email ?? "").trim().toLowerCase();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const otpToken = crypto.randomBytes(16).toString("hex");

  // ---- CHANNEL 1 (PRIMARY): EMAIL. SES is live in production TODAY, so a DOB-less candidate with an
  // email on file can self-serve NOW — this is the whole point of qa-2809's email addition on top of
  // -321's phone-only second factor (prod SMS is OFF, so -321 cannot actually deliver). The address
  // is the one on the MATCHED record; it is NEVER asked for (a typed address proves nothing — same
  // second-factor logic as the phone path). Reuses forgot-password / enrol-otp's email apparatus:
  // emailChallengeGate (per-address cooldown + 5/hour, NO daily cap — email costs nothing),
  // renderMail + sendMail. The response is uniform (never reveals whether an address is on file —
  // anti-enumeration, same posture as forgot-password and the SMS branch below).
  if (email) {
    const gate = emailChallengeGate(email);
    if (!gate.ok) {
      throw new HttpError(429, gate.reason === "cooldown"
        ? `Please wait ${gate.retryAfterSec ?? 60} seconds before requesting another code.`
        : "Too many codes requested — please try again later.");
    }
    // One live challenge per address — a new request burns the old one. Store BOTH the email (the
    // channel marker + the anti-enumeration key) and the phone on file, so the verify seam re-resolves
    // the candidate the same way for either channel (a DOB-less candidate on this door always carries
    // a phone — it is how step 1 matched them). No schema change: attendance_otp already has both.
    await PublicToken.updateMany({ purpose: "attendance_otp", email, active: true }, { $set: { active: false } });
    await PublicToken.create({
      token: otpToken, purpose: "attendance_otp", email, phone: otpPhone,
      otp_hash: sha(code), otp_expires_at: new Date(Date.now() + 10 * 60_000), otp_attempts: 0,
    });
    // Server-built mail; the code stays in the REAL subject (notification preview) but NEVER in the
    // log (QA-142 — log_subject masks it). Mail is suppressed structurally in test/CI (test DB) and
    // when SES creds are absent — sendMail records a MailLog row either way and never throws.
    const { html, text } = renderMail({
      title: "Your verification code",
      lines: [`Your one-time code is:`, code, `It works for 10 minutes. If you did not ask for this, ignore this mail.`],
    });
    sendMail({ to: email, subject: `${code} is your Vidysea verification code`, log_subject: "****** is your Vidysea verification code", html, text, entity: "PublicToken" }).catch(() => {});
    return NextResponse.json({
      otp_required: true, otp_token: otpToken, channel: "email",
      message: "We've sent a 6-digit code to the email on your record. Enter it to open your training.",
    });
  }

  // ---- CHANNEL 2 (FALLBACK): SMS, for a candidate with NO email on file. Unchanged from -321 except
  // it is now the SECOND choice. Works only once EnableX SMS is switched on (ops/env step —
  // ENABLEX_SMS_* + the OTP DLT template); production today has no configured template, so this
  // returns the "not switched on yet" copy (the centre-coordinator dead-end). Toll-fraud gates keyed
  // on the NUMBER being paid for: per-phone cap, resend cooldown, global daily cap.
  const gate = phoneChallengeGate(otpPhone);
  if (!gate.ok) {
    if (gate.reason === "daily_cap") {
      await Notification.create({
        type: "sms_daily_cap", severity: "warning",
        message: `SMS daily cap reached (${process.env.SMS_DAILY_CAP ?? 500}) — portal OTP sending paused until the window resets. Raise SMS_DAILY_CAP if this is legitimate volume.`,
        entity: "System", role_target: ["Admin", "Operations"],
      }).catch(() => {});
      throw new HttpError(429, "SMS sending is paused for today — please try again later or contact the centre.");
    }
    throw new HttpError(429, gate.reason === "cooldown"
      ? `Please wait ${gate.retryAfterSec ?? 60} seconds before requesting another code.`
      : "Too many codes sent to this number — please try again later.");
  }
  // One live challenge per number — a new request burns the old one.
  await PublicToken.updateMany({ purpose: "attendance_otp", phone: otpPhone, active: true }, { $set: { active: false } });
  await PublicToken.create({
    token: otpToken, purpose: "attendance_otp", phone: otpPhone,
    otp_hash: sha(code), otp_expires_at: new Date(Date.now() + 10 * 60_000), otp_attempts: 0,
  });
  // The template's var1 is a name; there is none on this door either. "Student" keeps the approved
  // text intact. The code is NEVER written to the log (QA-142). SMS is skipped structurally in
  // test/CI and when no DLT template is configured (production today) — see sendSms/smsConfigured.
  sendSms({ to: otpPhone, purpose: "otp", values: { name: "Student", code }, log_preview: "OTP for verification is ****** (template 888579131)", entity: "PublicToken" }).catch(() => {});
  return NextResponse.json({
    otp_required: true, otp_token: otpToken, channel: "sms",
    message: smsTemplateFor("otp")
      ? "We've sent a 6-digit code by SMS to the number on file. Enter it to open your training."
      : "SMS codes are not switched on yet — please ask your centre coordinator for your link.",
  });
});
