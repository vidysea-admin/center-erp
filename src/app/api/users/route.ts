import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { User } from "@/models";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "users.manage"); // togglable (2026-08-11); Admin-only by default (Rule 40)
  const items = await User.find({}, "-password_hash").populate("location_scope", "name code").lean();
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "users.manage"); // togglable (2026-08-11)
  const body = await req.json();
  if (!body.name || !body.email || !body.password || !body.role) {
    throw new HttpError(400, "name, email, password, role are required");
  }
  // Security review 2026-08-11: users.manage is grantable — creating an Admin (or a user
  // with pre-granted special rights) stays an Admin-only act.
  if ((body.role === "Admin" || (body.extra_permissions?.length ?? 0) > 0) && user.role !== "Admin") {
    throw new HttpError(403, "Only an Admin may create Admin accounts or grant special rights.");
  }
  const doc = await User.create({
    name: body.name, email: body.email,
    password_hash: await bcrypt.hash(body.password, 10),
    role: body.role,
    location_scope: body.location_scope ?? [],
    can_edit: body.can_edit ?? false,
    active: body.active ?? true,
  });
  await audit({ entity: "User", entityId: doc._id, newValue: "created " + body.email, actor: user.id });
  const { password_hash: _ph, ...safe } = doc.toObject();
  return NextResponse.json({ item: safe }, { status: 201 });
});
