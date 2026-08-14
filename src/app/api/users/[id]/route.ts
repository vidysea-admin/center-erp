import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, HttpError, invalidateIdentity } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { User } from "@/models";
import { audit } from "@/lib/audit";

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "users.manage"); // togglable (2026-08-11)
  requireEdit(user); // Rule 39: a view-only holder of a granted right still may not write
  const { id } = await ctx.params;
  const doc = await User.findById(id);
  if (!doc) throw new HttpError(404, "User not found");
  const body = await req.json();

  // Privilege escalation guards (security review 2026-08-11): users.manage is a GRANTABLE
  // right, so a non-Admin holder must never be able to raise anyone's privileges — role,
  // rights, edit flag, activation and approvals stay Admin-only. And nobody, Admin
  // included, edits their own privileges.
  // 2026-08-12 audit (S0): `password` and `email` were missing from this list, so a body of
  // only {"password":"…"} skipped the Admin check below and rewrote the hash further down —
  // any non-Admin holding the GRANTABLE users.manage right could reset the Admin's password
  // and take over the account. Credentials ARE privileges; they belong in this list.
  const PRIV_FIELDS = ["role", "location_scope", "can_edit", "active", "extra_permissions", "revoked_permissions", "password", "email"];
  const changingPriv = PRIV_FIELDS.some((f) => body[f] !== undefined) || body.approval !== undefined;
  if (changingPriv && user.role !== "Admin") {
    throw new HttpError(403, "Only an Admin may change roles, rights or account status.");
  }
  if (changingPriv && String(doc._id) === String(user.id)) {
    throw new HttpError(400, "You cannot change your own role, rights or account status.");
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
  const { password_hash: _ph, ...safe } = doc.toObject();
  return NextResponse.json({ item: safe });
});
