import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { User } from "@/models";
import { audit } from "@/lib/audit";

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "users.manage"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  const doc = await User.findById(id);
  if (!doc) throw new HttpError(404, "User not found");
  const body = await req.json();
  for (const f of ["name", "email", "role", "location_scope", "can_edit", "active", "extra_permissions"]) {
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
  await audit({ entity: "User", entityId: doc._id, field: body.approval ? `signup ${body.approval}d` : "updated", actor: user.id });
  const { password_hash: _ph, ...safe } = doc.toObject();
  return NextResponse.json({ item: safe });
});
