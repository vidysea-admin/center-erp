import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, HttpError, invalidateIdentity, readJson } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { User } from "@/models";
import { audit } from "@/lib/audit";
import { emailError } from "@/lib/validate";
import { renderMail, sendMail } from "@/lib/mailer";

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
  // QA-1912a — the last-Admin lockout. Nothing stopped the final Admin being demoted, deactivated
  // or dropped, and `api/permissions/route.ts:36` refuses to edit the Admin role row, so there is no
  // in-app path back: recovery would need direct database access. That is a one-click, unrecoverable
  // mistake sitting on the screen an Admin uses every day.
  //
  // It is not hypothetical. Umesh is about to run a runbook whose steps 3-4 DEMOTE every Admin but
  // three, on a production system that currently has exactly TWO active Admins - so the sequence
  // passes within one demotion of zero. This guard is why that step is being held.
  //
  // THREE PATHS remove an Admin and each writes separately - `drop` returns early, `active: false`
  // and a `role` change both fall through to the field loop. One helper, called before any of them
  // writes, because a guard that covers two of three is the shape this repo keeps paying for.
  const wouldRemoveAnAdmin =
    body.drop === true
    || (body.active === false && doc.active)
    || (body.role !== undefined && body.role !== "Admin" && doc.role === "Admin");
  if (wouldRemoveAnAdmin && doc.role === "Admin") {
    // Count only Admins who can ACTUALLY sign in - `authorize()` refuses a Pending or Rejected
    // account and refuses `active: false`, so counting rows that merely say "Admin" would let the
    // system pass this check while nobody alive holds the role.
    const isEffective = doc.active && !doc.dropped && doc.approval_status === "Approved";
    if (isEffective) {
      const others = await User.countDocuments({
        _id: { $ne: doc._id }, role: "Admin", active: true,
        dropped: { $ne: true }, approval_status: "Approved",
      });
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
