import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, HttpError, invalidateIdentity, readJson } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { User } from "@/models";
import { audit } from "@/lib/audit";
import { emailError } from "@/lib/validate";
import { renderMail, sendMail } from "@/lib/mailer";

// QA-1996 (checker, cycle 1, S2) — THE GUARD BELOW WAS CHECK-THEN-WRITE, AND THE CHECK WAS A
// COUNT. Two live Admins each deactivating the OTHER in the same instant both read "one other
// Admin still exists", both pass, both write, and the system is left with ZERO Admins who can
// sign in - with no way back in, because the Admin role cannot be granted from the rights screen.
// The checker reproduced it 3 of 3 rounds on the unmutated build and then could not sign in to
// its own copy; recovery took a direct collection write.
//
// The maker had told Umesh this hazard was UNREACHABLE, twice, after a pin failed to produce it.
// That pin only ever issued requests one at a time. "I could not make it happen" is not "it
// cannot happen", and the difference here was two requests instead of one.
//
// There is no transaction on this route and mongod runs standalone in CI, so `$transaction` is
// not available to lean on. What closes the window instead is verifying AFTER the write, where
// the race is actually visible, and UNDOING our own write if the floor broke. Both racers then
// see zero, both restore, both are refused - the outcome lands on the safe side (two Admins
// still standing) rather than the unrecoverable one.
//
// The cheap pre-check is kept as well: it gives the ordinary single-request case a clean 409
// without a write ever happening. It is the fast path, not the guarantee.
// QA-2014 — WHO COUNTS AS AN ADMIN WHO CAN SIGN IN, and this guard had a NARROWER answer than the
// login door does. `authorize()` (src/auth.ts:53-54) refuses only "Pending" and "Rejected"; an
// account whose approval_status is ABSENT signs in perfectly well. This guard counted
// `approval_status: "Approved"` and therefore could not see such an account at all.
//
// That is not hypothetical: `scripts/seed.mjs` inserts the very first Admin through the raw
// driver, so no Mongoose default applies and the field is simply missing. On a fresh install the
// ONE Admin who can actually sign in was invisible here - which meant the pre-check's
// `isEffective` was false for them and the guard was skipped ENTIRELY when removing them. No race
// required; one ordinary request would do it. Found by this unit's own new suite reporting
// "at least three Admins can sign in" as count=2 - a fixture assertion that turned out to be
// measuring the product.
//
// The mirror-image cost mattered too: `enforceAdminFloor` would have read zero, undone a
// perfectly good change and answered 409, with a live Admin sitting right there.
//
// `$nin` matches documents where the field is absent, which is exactly the population
// `authorize()` admits. One definition, used by both the pre-check and the post-write check.
const CAN_SIGN_IN = { active: true, dropped: { $ne: true }, approval_status: { $nin: ["Pending", "Rejected"] } };
const canSignIn = (u: { active?: unknown; dropped?: unknown; approval_status?: unknown }) =>
  u.active === true && u.dropped !== true && u.approval_status !== "Pending" && u.approval_status !== "Rejected";

async function enforceAdminFloor(docId: unknown, restore: Record<string, unknown>) {
  const effective = await User.countDocuments({ role: "Admin", ...CAN_SIGN_IN });
  if (effective > 0) return;
  await User.updateOne({ _id: docId }, { $set: restore });
  invalidateIdentity(String(docId));
  throw new HttpError(409,
    "That change would have left the system with no Admin who can sign in - another Admin was being changed at the same moment. Nothing was saved. Check who is still an Admin, then try again.");
}

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "users.manage"); // togglable (2026-08-11)
  requireEdit(user); // Rule 39: a view-only holder of a granted right still may not write
  const { id } = await ctx.params;
  const doc = await User.findById(id);
  if (!doc) throw new HttpError(404, "User not found");
  const body = await readJson(req);

  // Privilege escalation guards (security review 2026-08-11): users.manage is a GRANTABLE
  // right, so a non-Admin holder must never be able to raise anyone's privileges — role,
  // rights, edit flag, activation and approvals stay Admin-only. And nobody, Admin
  // included, edits their own privileges.
  // 2026-08-12 audit (S0): `password` and `email` were missing from this list, so a body of
  // only {"password":"…"} skipped the Admin check below and rewrote the hash further down —
  // any non-Admin holding the GRANTABLE users.manage right could reset the Admin's password
  // and take over the account. Credentials ARE privileges; they belong in this list.
  const PRIV_FIELDS = ["role", "location_scope", "can_edit", "active", "extra_permissions", "revoked_permissions", "password", "email"];
  const changingPriv = PRIV_FIELDS.some((f) => body[f] !== undefined) || body.approval !== undefined || body.drop === true;
  if (changingPriv && user.role !== "Admin") {
    throw new HttpError(403, "Only an Admin may change roles, rights or account status.");
  }
  if (changingPriv && String(doc._id) === String(user.id)) {
    throw new HttpError(400, "You cannot change your own role, rights or account status.");
  }

  // 15/08 (Umesh): DROP a user — soft by design. "Logs me history rahegi, inka banaya data
  // waise hi rahega, drop karke naya create kar sakte hain." The row stays (created_by refs
  // and the audit trail keep their names), the login dies now (active=false +
  // invalidateIdentity below), and the email is renamed so the unique index frees up for a
  // fresh account. Nothing the person created is touched.
  // QA-1912a / QA-1996 — THE LAST-ADMIN FLOOR. This comment used to say the guard below was
  // UNREACHABLE. That was wrong, it was published, and it is worth keeping the record of how.
  //
  // The argument was: removing an Admin needs `changingPriv`, which 403s a non-Admin actor, and
  // `requireUser` (authz.ts:93) refuses an inactive or unapproved caller — so the actor is always a
  // live Admin. Either they are somebody else, in which case they ARE the other active Admin that
  // makes the target not-last; or they are the target, and the self-edit rule refuses first.
  // "There is no third case."
  //
  // There is a third case, and it is TWO REQUESTS. Two live Admins each removing the other at the
  // same instant both read `others === 1`, both pass, both write. Zero Admins, no way back. A
  // checker reproduced it 3 of 3 rounds; its own cleanup then could not sign in and needed a
  // direct collection write. Every sentence of the argument above is true of ONE request at a time,
  // and the conclusion is false anyway — which is why it is left standing here rather than deleted.
  // "I could not make it happen" is not "it cannot happen".
  //
  // So the guard is NOT decoration. `enforceAdminFloor` (above) re-checks AFTER the write, where
  // the race is visible, and undoes a write that broke the floor. The cheap pre-check below is the
  // fast path for the ordinary single request; it is not the guarantee.
  //
  // Residual, stated here and not only in a manifest: the fix is COMPENSATING, not atomic. There is
  // no transaction on this route and mongod runs standalone in CI. If the undo write itself fails,
  // the system is left as the race left it. A cycle-2 checker attacked this with three-way and
  // mixed-door races and could not break it, but that is evidence, not a proof.
  //
  // It stays for two reasons. The thing it guards is UNRECOVERABLE — the Admin role cannot be
  // granted back from the rights screen; the locks that actually hold it are `users/[id]/route.ts:31`
  // (this file's own PRIV_FIELDS self-edit refusal) and `users/route.ts:38`. QA-2000: this used to
  // cite `permissions/route.ts:36`, which governs the role-permission MATRIX and not who may hold
  // the Admin role at all — a wrong citation sends the next reader to the wrong file to check
  // whether recovery is possible. And the lock that
  // actually holds the floor today is a rule about SELF-EDITS: a different intention that happens to
  // have this effect, which a future route, script, or relaxation would remove without anyone
  // noticing what else it was doing. The pin records WHICH lock is load-bearing, so that change is
  // visible rather than silent.
  //
  // THREE PATHS remove an Admin and each writes separately - `drop` returns early, `active: false`
  // and a `role` change both fall through to the field loop. One helper, called before any of them
  // writes, because a guard that covers two of three is the shape this repo keeps paying for.
  // QA-1997 (checker, cycle 1): there are FOUR doors, not three. `{approval:"reject"}` sets
  // approval_status="Rejected" AND active=false further down this same file, and it was not in
  // this list - so the guard that was written because "a guard covering two of three is the shape
  // this repo keeps paying for" shipped covering three of four.
  // Snapshot BEFORE any mutation, so enforceAdminFloor can put this row back exactly as it was.
  const adminFloorRestore = {
    active: doc.active, dropped: doc.dropped, role: doc.role, approval_status: doc.approval_status,
    email: doc.email, dropped_email: doc.dropped_email,
  };
  const guardsTheFloor = doc.role === "Admin";

  const wouldRemoveAnAdmin =
    body.drop === true
    || (body.active === false && doc.active)
    || body.approval === "reject"
    || (body.role !== undefined && body.role !== "Admin" && doc.role === "Admin");
  if (wouldRemoveAnAdmin && doc.role === "Admin") {
    // Count only Admins who can ACTUALLY sign in - `authorize()` refuses a Pending or Rejected
    // account and refuses `active: false`, so counting rows that merely say "Admin" would let the
    // system pass this check while nobody alive holds the role.
    const isEffective = canSignIn(doc as any); // QA-2014: the login door's definition, not a narrower one
    if (isEffective) {
      const others = await User.countDocuments({ _id: { $ne: doc._id }, role: "Admin", ...CAN_SIGN_IN });
      if (others === 0) {
        throw new HttpError(409,
          "This is the only Admin who can still sign in, and there is no way to make a new one from inside the app — the Admin role cannot be granted back from the rights screen. Create and confirm another Admin first, then change this one.");
      }
    }
  }

  if (body.drop === true) {
    if (doc.dropped) throw new HttpError(400, `${doc.name} is already dropped.`);
    const original = doc.email;
    doc.dropped = true;
    doc.dropped_email = original;
    doc.email = `dropped.${Date.now()}.${original}`;
    doc.active = false;
    await doc.save();
    if (guardsTheFloor) await enforceAdminFloor(doc._id, adminFloorRestore); // QA-1996
    invalidateIdentity(String(doc._id));
    await audit({
      entity: "User", entityId: doc._id, field: "dropped",
      oldValue: original,
      newValue: `dropped by ${user.name} — was ${doc.role}${doc.can_edit ? " (edit)" : " (view-only)"}, email freed for re-use`,
      actor: user.id,
    });
    const { password_hash: _p, ...safeDrop } = doc.toObject();
    return NextResponse.json({ item: safeDrop });
  }

  // A dropped account is terminal — the flow is drop → create a fresh account, not revive.
  if (doc.dropped) throw new HttpError(400, `${doc.name} was dropped. Create a new account instead of editing this one.`);

  // QA-141 (Umesh): a changed login email must still be one (format-checked like creation).
  if (body.email !== undefined) {
    const eErr = emailError(body.email);
    if (eErr) throw new HttpError(400, eErr);
  }
  for (const f of ["name", "email", "role", "location_scope", "can_edit", "active", "extra_permissions", "revoked_permissions"]) {
    if (body[f] !== undefined) (doc as any)[f] = body[f];
  }
  if (body.password) doc.password_hash = await bcrypt.hash(body.password, 10);

  // 2026-08-11 (CEO): approve/reject self-signups. Approval activates the account with the
  // (possibly adjusted) role, scope and edit flag; rejection keeps it locked out.
  if (body.approval === "approve") {
    if (String(doc._id) === String(user.id)) throw new HttpError(400, "You cannot approve yourself.");
    doc.approval_status = "Approved";
    doc.active = true;
    doc.approved_by = user.id as any;
    doc.approved_at = new Date();
    if (doc.role === "Trainer" && doc.can_edit === false && body.can_edit === undefined) {
      doc.can_edit = true; // a trainer login exists to enter daily logs — read-only would be pointless
    }
  } else if (body.approval === "reject") {
    doc.approval_status = "Rejected";
    doc.active = false;
  }

  await doc.save();
  // QA-1996: the floor is re-verified HERE, after the write, because the two-Admin race is
  // invisible before it. A violation undoes this write and answers 409.
  if (guardsTheFloor && wouldRemoveAnAdmin) await enforceAdminFloor(doc._id, adminFloorRestore);
  // QA-080: a privilege/identity change must bite the person's LIVE session on their very
  // next request — not after the identity cache's TTL. Stop access = stopped now.
  if (changingPriv || body.approval) invalidateIdentity(String(doc._id));
  await audit({ entity: "User", entityId: doc._id, field: body.approval ? `signup ${body.approval}d` : "updated", actor: user.id });
  // QA-115 (CEO [19:48] "I didn't get the mail" — this WAS the mail): tell the person
  // their account is live. Fire-and-forget — mail can never fail the approval.
  if (body.approval === "approve") {
    const { html, text } = renderMail({
      title: "Your Center ERP account is approved",
      lines: [`Hello ${doc.name},`, `Your account (${doc.email}) has been approved as ${doc.role}. You can sign in now.`],
      cta: { label: "Sign in to the ERP", url: "https://www.vidysea.com/erp" },
    });
    sendMail({ to: doc.email, subject: "Your Center ERP account is approved", html, text, entity: "User", entity_id: doc._id }).catch(() => {});
  }
  const { password_hash: _ph, ...safe } = doc.toObject();
  return NextResponse.json({ item: safe });
});
