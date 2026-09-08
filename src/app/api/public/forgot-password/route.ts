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

    // QA-2097 (checker, cycle 1, S1, CRITICAL) — THE FEATURE WAS INOPERABLE THROUGH ITS OWN PAGE.
    // (QA-2202: this comment cited **QA-2111** for weeks. QA-2111 is a different unit's row —
    // `qa-1912a`, an S3 wrong-citation finding — so the id an auditor followed from here landed
    // on somebody else's wrong citation, which is a small and complete irony. QA-2097 is the row
    // whose title is this defect verbatim.)
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
    if (!gate.ok) {
      // QA-2201 (checker, cycle 2) — THE CYCLE-1 DEFECT WAS FIXED ON THE MAIN BRANCH AND LEFT
      // ALIVE ON THIS ONE. Returning `okResponse` here hands back a DECOY token — 16 random
      // bytes that were never stored — to a real person inside the 60-second per-address
      // cooldown. `forgot/page.tsx` does `setToken(d.token ?? "")`, so it discards the good
      // token it was holding, and the live challenge (whose mailed code is still perfectly
      // valid) becomes unreachable from the page. The screen then shows two contradictory
      // sentences at once — "a code is on its way" and "that code did not work… request a new
      // one" — and the advice it gives is the exact action that reproduces the failure.
      //
      // The most ordinary thing a person does on this screen reproduces it: ask, not see the
      // mail, retype the same address, ask again.
      //
      // FIX: hand back the token of the address's LIVE challenge. This leaks nothing, because
      // a live row exists for BOTH branches — the QA-2100 fix above gives an unknown address a
      // real row with an unmatchable `otp_hash` — so the presence of a token is uniform and is
      // not the enumeration tell this file exists to avoid. It is a session handle, not the
      // credential, which is already this file's stated position twelve lines up.
      //
      // Nineteen assertions and then seventy passed over the cycle-1 version of this bug for
      // one reason, and it is the same reason here: the suite drives `verify` with a token it
      // reads out of Mongo, so no test has ever used a token the PAGE was handed. The resend
      // path is pinned in a real browser now (`scripts/e2e-password.mjs`), because that is the
      // second time a defect has lived exactly where no test touches the page's state machine.
      // WHAT THIS HANDS A STRANGER, stated because a peer session asked and the answer is not
      // self-evident: a caller who asks for SOMEBODY ELSE'S address inside that person's 60s
      // window now receives that person's live token, and can therefore burn `otp_attempts` on a
      // challenge the victim is actively using.
      //
      // That capability is NOT introduced here, and it is strictly WEAKER than what the same
      // caller already has one second later. Outside the cooldown, a request for the same address
      // runs the `updateMany({ active: true }, { active: false })` above — it DESTROYS the
      // victim's live challenge outright and mints a new one whose token it is handed anyway. So
      // the pre-existing capability is "invalidate their code completely"; the one added here is
      // "spend attempts on it". Closing the second while the first stands open would be theatre.
      //
      // The real answer to both is per-subject rate limiting, which is what `emailChallengeGate`
      // is, and a distributed attacker defeats it because the buckets are per-process — Redis,
      // still deferred, still the complete answer (`rate-limit.ts`).
      const live = await PublicToken.findOne({
        purpose: "password_reset", email, active: true, otp_expires_at: { $gt: new Date() },
      }).select("token").lean<any>();
      if (!live?.token) return okResponse;
      return NextResponse.json({
        ok: true,
        token: live.token,
        message: "If that address belongs to an account, a 6-digit code is on its way. It works for 10 minutes.",
      });
    }

    const doc = await User.findOne({ email }).select("_id name active dropped approval_status").lean<any>();
    // An account that cannot sign in must not be able to start a reset either - otherwise this door
    // is a way to mail a deactivated or rejected person a working code. Mirrors authorize()
    // (src/auth.ts:53-54), which refuses only Pending and Rejected: an ABSENT approval_status signs
    // in fine, and QA-2014 is the row for what happens when a check is narrower than that one.
    const canSignIn = doc && doc.active === true && doc.dropped !== true
      && doc.approval_status !== "Pending" && doc.approval_status !== "Rejected";

    // QA-2100 (checker, cycle 1) — A TIMING ORACLE SEPARATED THE TWO BRANCHES 9/9, WITH NO
    // OVERLAP. Returning an identical message is not enough when the WORK differs: the real
    // branch did two database writes before answering and the unknown branch returned
    // immediately, so a stopwatch told a caller which addresses belong to accounts — the exact
    // thing every `fail()` and every equal message in this file exists to prevent.
    //
    // So BOTH branches now do the same two writes. An address with no account gets a real row
    // with an `otp_hash` of random bytes: nothing can ever match it, so it burns attempts and
    // expires exactly like a real challenge and is indistinguishable from one. It costs a
    // 10-minute inert row, which is the price of the property.
    //
    // The mail is the only asymmetric step left, and it is already off the response path
    // (fire-and-forget, `.catch(() => {})`) — `sendMail` never throws by design.
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const token = crypto.randomBytes(16).toString("hex");
    // One live challenge per address - requesting again burns the previous code rather than
    // leaving two valid ones in two inboxes.
    await PublicToken.updateMany({ purpose: "password_reset", email, active: true }, { $set: { active: false } });
    await PublicToken.create({
      token, purpose: "password_reset", email,
      // A real account gets the hash of the code that is about to be mailed. Anything else gets
      // 32 bytes nobody holds - a challenge that exists, ages and burns, and can never be met.
      otp_hash: canSignIn ? sha(code) : crypto.randomBytes(32).toString("hex"),
      otp_expires_at: new Date(Date.now() + 10 * 60_000), otp_attempts: 0,
    });
    if (!canSignIn) {
      return NextResponse.json({
        ok: true,
        token,
        message: "If that address belongs to an account, a 6-digit code is on its way. It works for 10 minutes.",
      });
    }

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

    // QA-2101 — THE COMMENT SAID "burned before anything else can go wrong" AND THE BURN RAN
    // AFTER THE PASSWORD WRITE. If `doc.save()` threw, the caller saw a failure and the challenge
    // was left verified and replayable. The sentence was true of the intention and false of the
    // order, which is this unit's recurring fault in miniature.
    //
    // Burning FIRST fails closed: if the password write then throws, the person requests a new
    // code — mildly annoying, and strictly better than a live single-use token surviving a failed
    // reset.
    t.active = false;
    t.otp_verified = false;
    await t.save();

    doc.password_hash = await bcrypt.hash(next, 10);
    await doc.save();

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
