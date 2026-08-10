import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { User } from "@/models";
import { audit } from "@/lib/audit";

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin");
  const { id } = await ctx.params;
  const doc = await User.findById(id);
  if (!doc) throw new HttpError(404, "User not found");
  const body = await req.json();
  for (const f of ["name", "email", "role", "location_scope", "can_edit", "active"]) {
    if (body[f] !== undefined) (doc as any)[f] = body[f];
  }
  if (body.password) doc.password_hash = await bcrypt.hash(body.password, 10);
  await doc.save();
  await audit({ entity: "User", entityId: doc._id, field: "updated", actor: user.id });
  const { password_hash: _ph, ...safe } = doc.toObject();
  return NextResponse.json({ item: safe });
});
