import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError, readJson, invalidateIdentity } from "@/lib/authz";
import { rateLimit, clientKey, emailChallengeGate } from "@/lib/rate-limit";
import { PublicToken, User } from "@/models";
import { renderMail, sendMail } from "@/lib/mailer";
import { audit } from "@/lib/audit";

// QA-1829b — FORGOT PASSWORD. The other half of QA-1829; qa-1829a shipped the half that needs no
// mail (a signed-in person changing their own password, proving the old one).
//
// WHY IT EXISTS, IN UMESH'S WORDS: Karunn and Shubhi's accounts are created for them, and the
// handover should not involve anyone knowing anyone else's password. With this, no password is ever
// shared at all - the account is created, they click "Forgot password?", and each sets their own
// from their own mailbox. Before this existed, the only recovery was an Admin typing a new password
// and sending it, which is a live credential in a chat window.
//
// THREE THINGS THIS FILE IS CAREFUL ABOUT, each because the codebase already paid for it:
//
// 1. IT NEVER SAYS WHETHER AN ACCOUNT EXISTS. One `fail()` closure, reused on every branch, exactly
//    as `api/public/portal-lookup/route.ts` does. A reset endpoint that answers differently for a
//    real and an unknown address is a free list of who works here - and this app's login page is
//    public. The `request` action goes further: it answers OK either way and simply does not send.
// 2. THE EMAIL LOOKUP IS `.trim().toLowerCase()`, matching `src/auth.ts:43` exactly. That mismatch
//    is literally QA-1628 - a lookup that disagreed with the login door by one `toLowerCase()`.
// 3. IT DOES NOT TOUCH `PRIV_FIELDS`. `password` sits in that list deliberately (an S0 fix from
//    2026-08-12: nobody edits their own role, rights or status through the user route). This is a
//    separate public door with its own proof, the same shape as `/api/me/password`.
//
// The challenge apparatus is `PublicToken`'s, not a new one: hash-only storage, 10-minute expiry,
// five wrong tries burn the token, `active` revokes it. Only the PURPOSE is new.

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// One sentence for every failure on the verify/reset path. Deliberately vague about WHICH thing was
// wrong, because "that code is wrong" and "no such session" together tell an attacker whether the
// address was real.
const fail = () => new HttpError(400, "That code did not work. It may have expired or already been used — request a new one.");

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const body = await readJson(req).catch(() => ({}));
  if (body.website) throw new HttpError(400, "Invalid submission."); // honeypot, same as trainer-apply
  const action = String(body.action ?? "");

  // ------------------------------------------------------------------ request a code
  if (action === "request") {
    rateLimit("pwreset-req:" + clientKey(req), 5, 60 * 60_000);
    const email = String(body.email ?? "").trim().toLowerCase(); // QA-1628: same as auth.ts:43

    // QA-2111 (checker, cycle 1, CRITICAL) — THE FEATURE WAS INOPERABLE THROUGH ITS OWN PAGE.
    // This response carried no `token`, so `/forgot` set token = "" and every verify that followed
    // looked up the empty string and failed. Nobody could reset a password through the UI.
    //
    // Nineteen assertions passed over it because the FIXTURE read the token out of the database
    // instead of out of the response — so the suite exercised the API and never the path a person
    // takes. That is this project's own "a pin that cannot fail" shape, arriving through the
    // fixture rather than through the assertion.
    //
    // THE TOKEN IS RETURNED IN BOTH CASES, and that is the anti-enumeration requirement rather
    // than a hole in it: it is a session handle, not the credential. Possession of it proves
    // nothing — the 6-digit code still has to arrive by mail. Returning it only for real accounts
    // would make its presence the very tell this endpoint refuses to give. An unknown address gets
    // a decoy: a random token that was never stored, so verify answers the same generic refusal a
    // wrong code gets. Same shape as `enrol-otp`, which also hands back its token.
    const okResponse = NextResponse.json({
      ok: true,
      token: crypto.randomBytes(16).toString("hex"), // replaced below when there is a real account
      message: "If that address belongs to an account, a 6-digit code is on its way. It works for 10 minutes.",
    });
    if (!email || !email.includes("@")) return okResponse;

    // Per-SUBJECT, not per-caller: the mail lands in a real person's inbox and rotating IPs must not
    // buy more of them. Silent to the caller for the same anti-enumeration reason.
    const gate = emailChallengeGate(email);
    if (!gate.ok) return okResponse;

    const doc = await User.findOne({ email }).select("_id name active dropped approval_status").lean<any>();
    // An account that cannot sign in must not be able to start a reset either - otherwise this door
    // is a way to mail a deactivated or rejected person a working code. Mirrors authorize()
    // (src/auth.ts:53-54), which refuses only Pending and Rejected: an ABSENT approval_status signs
    // in fine, and QA-2014 is the row for what happens when a check is narrower than that one.
    const canSignIn = doc && doc.active === true && doc.dropped !== true
      && doc.approval_status !== "Pending" && doc.approval_status !== "Rejected";
    if (!canSignIn) return okResponse;

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const token = crypto.randomBytes(16).toString("hex");
    // One live challenge per address - requesting again burns the previous code rather than leaving
    // two valid ones in two inboxes.
    await PublicToken.updateMany({ purpose: "password_reset", email, active: true }, { $set: { active: false } });
    await PublicToken.create({
      token, purpose: "password_reset", email,
      otp_hash: sha(code), otp_expires_at: new Date(Date.now() + 10 * 60_000), otp_attempts: 0,
    });

    const { html, text } = renderMail({
      title: "Your password reset code",
      lines: [
        `Hello ${doc.name},`,
        `Your one-time code is:`,
        code,
        `It works for 10 minutes and can be used once.`,
        `If you did not ask to reset your password, ignore this mail — your password has not changed.`,
      ],
    });
    // QA-142: the code stays in the REAL subject (it is what a phone's lock-screen preview shows)
    // and NEVER in the log - the Admin mail panel must not become a list of live reset codes.
    sendMail({
      to: email,
      subject: `${code} is your password reset code`,
      log_subject: "****** is your password reset code",
      html, text, entity: "PublicToken",
    }).catch(() => {});

    // The real token, in a response otherwise byte-identical to the decoy one above.
    return NextResponse.json({
      ok: true,
      token,
      message: "If that address belongs to an account, a 6-digit code is on its way. It works for 10 minutes.",
    });
  }

  // ------------------------------------------------------------------ check the code
  // Separated from `reset` so the screen can tell somebody their code is wrong BEFORE asking them to
  // think of a new password, rather than after.
  if (action === "verify") {
    rateLimit("pwreset-ver:" + clientKey(req), 20, 60 * 60_000);
    const t = await PublicToken.findOne({ token: String(body.token ?? ""), purpose: "password_reset", active: true });
    if (!t) throw fail();
    if (t.otp_expires_at && t.otp_expires_at < new Date()) { t.active = false; await t.save(); throw fail(); }
    if ((t.otp_attempts ?? 0) >= 5) { t.active = false; await t.save(); throw fail(); }
    if (sha(String(body.code ?? "")) !== t.otp_hash) {
      t.otp_attempts = (t.otp_attempts ?? 0) + 1;
      await t.save();
      throw fail();
    }
    t.otp_verified = true;
    await t.save();
    return NextResponse.json({ ok: true });
  }

  // ------------------------------------------------------------------ set the new password
  if (action === "reset") {
    rateLimit("pwreset-set:" + clientKey(req), 10, 60 * 60_000);
    const t = await PublicToken.findOne({ token: String(body.token ?? ""), purpose: "password_reset", active: true, otp_verified: true });
    if (!t) throw fail();
    if (t.otp_expires_at && t.otp_expires_at < new Date()) { t.active = false; await t.save(); throw fail(); }

    const next = String(body.password ?? "");
    // The same floor `/api/me/password` applies, and for the same reason: this door can set the
    // password of an account that approves money. Stated plainly rather than as a generic message,
    // because the person is right here and can fix it.
    if (next.length < 8) throw new HttpError(400, "Please choose a password of at least 8 characters.");
    if (next.trim().toLowerCase() === String(t.email ?? "").trim().toLowerCase()) {
      throw new HttpError(400, "Please choose something other than your email address.");
    }

    const doc = await User.findOne({ email: String(t.email ?? "").trim().toLowerCase() });
    if (!doc) throw fail();

    doc.password_hash = await bcrypt.hash(next, 10);
    await doc.save();

    // SINGLE USE. Burned before anything else can go wrong, so a code cannot be replayed even if a
    // later step throws.
    t.active = false;
    t.otp_verified = false;
    await t.save();

    // QA-1967b is the unit that will kill OTHER live sessions on a password change and it does not
    // exist yet. This call is NOT that: it drops the identity cache so the next request re-reads the
    // row. Saying so here because a comment claiming session revocation would be the same overclaim
    // qa-1829a cycle 1 was charged for.
    invalidateIdentity(String(doc._id));

    await audit({
      entity: "User", entityId: doc._id, field: "password",
      newValue: "reset by the account holder via an emailed code",
      actor: doc._id,
    });

    return NextResponse.json({ ok: true, message: "Your password has been changed. Please sign in with it." });
  }

  throw new HttpError(400, "Unknown action.");
});
