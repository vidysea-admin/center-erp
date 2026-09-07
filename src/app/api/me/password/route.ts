import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError, invalidateIdentity, readJson } from "@/lib/authz";
import { User } from "@/models";
import { audit } from "@/lib/audit";
import { clientKey, rateLimit } from "@/lib/rate-limit";

// QA-1829a — "change my own password", the half of QA-1829 that needs no email at all.
//
// Umesh, 2026-09-07: *"karun and shubhi ka hum ek default password k sath account create krr dee aur
// baad mai with email verification they can update their password"*. The first half already works —
// `POST /api/users` takes a password and the welcome mail deliberately does NOT carry it. The second
// half did not exist in any form: `password` sits in PRIV_FIELDS on `PATCH /api/users/[id]`
// (correctly — it is an S0 fix from 2026-08-12, because credentials ARE privileges), and that route
// then refuses a self-edit, so **nobody could change their own password, Admin included**.
//
// Note what this route does NOT need: email verification. That is for someone who has FORGOTTEN
// their password and cannot prove who they are. Somebody who can log in with the password they were
// given proves it by typing it, which is what `current_password` below is for. The mail-token reset
// is the separate, larger half and is not this unit.
//
// THIS ROUTE IS DELIBERATELY NOT `PATCH /api/users/[id]` WITH THE GUARD RELAXED. Widening
// PRIV_FIELDS or carving a self-exception into it would re-open the exact hole that audit closed:
// a non-Admin holding the grantable `users.manage` right could rewrite an Admin's hash. This door
// can only ever change the CALLER's own password, it takes no id, and it touches no other field —
// so there is no id to tamper with and no privilege to escalate.
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();

  const body = await readJson(req);
  const current = String(body.current_password ?? "");
  const next = String(body.new_password ?? "");

  // Per-IP AND per-account. The per-IP bucket alone is the wrong shape here: `current_password` is
  // a guessing oracle against ONE named account, so an attacker who already has a session (a
  // shared machine, a borrowed laptop) rotates nothing and is limited by neither. Keyed on the
  // user id, the ceiling follows the thing being attacked rather than the caller.
  rateLimit(`pw-change-ip:${clientKey(req)}`, 20, 60_000);
  rateLimit(`pw-change-user:${user.id}`, 5, 15 * 60_000);

  if (!current || !next) throw new HttpError(400, "Enter your current password and the new one.");

  // The Admin-set path has no strength rule at all (`users/[id]/route.ts` hashes whatever arrives),
  // and this is not the unit that changes what an Admin may set for somebody else. What it will not
  // do is let a person choose something weaker for THEMSELVES than the floor stated on the screen.
  if (next.length < 8) throw new HttpError(400, "Your new password needs at least 8 characters.");
  if (next === current) throw new HttpError(400, "The new password is the same as your current one.");

  const doc = await User.findById(user.id);
  if (!doc) throw new HttpError(404, "Your account could not be read.");

  const ok = await bcrypt.compare(current, doc.password_hash);
  // Deliberately the same wording whether the account is odd or the password is wrong: this is an
  // authenticated route, so there is nothing to enumerate, but a message that distinguishes them
  // teaches an attacker on a borrowed session which half to work on.
  if (!ok) throw new HttpError(400, "That is not your current password.");

  // A person's own email should not double as their password. Cheap, and it is the one weak choice
  // this form can actually recognise.
  if (next.trim().toLowerCase() === String(doc.email ?? "").trim().toLowerCase()) {
    throw new HttpError(400, "Your password cannot be your email address.");
  }

  doc.password_hash = await bcrypt.hash(next, 10);
  await doc.save();

  // The identity cache holds `active` and `approval_status`; a credential change is exactly the
  // moment to stop serving a cached answer about this account (same call the Admin path makes).
  invalidateIdentity(String(doc._id));

  // `field: "password"` and not the generic "updated" the Admin path uses: an audit trail that
  // cannot distinguish a password change from a name change cannot answer the only question anybody
  // asks it afterwards. The VALUES are never recorded — old or new.
  await audit({ entity: "User", entityId: doc._id, field: "password", newValue: "changed by the account holder", actor: user.id });

  return NextResponse.json({ ok: true });
});
