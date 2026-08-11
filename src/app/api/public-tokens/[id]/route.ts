import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, requireEdit, HttpError } from "@/lib/authz";
import { PublicToken } from "@/models";
import { audit } from "@/lib/audit";

// PATCH { active: false } — revoke a public link. (Re-enable with active: true.)
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations");
  requireEdit(user);
  const { id } = await ctx.params;
  const body = await req.json();
  const doc = await PublicToken.findById(id);
  if (!doc) throw new HttpError(404, "Token not found");
  doc.active = !!body.active;
  await doc.save();
  await audit({ entity: "PublicToken", entityId: doc._id, field: "active", newValue: doc.active, actor: user.id });
  return NextResponse.json({ item: doc });
});
