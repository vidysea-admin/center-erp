import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { Room } from "@/models";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  assertLocationInScope(user, id);
  const items = await Room.find({ location: id }).lean();
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  assertLocationInScope(user, id);
  const body = await req.json();
  if (!body.name || !body.type) throw new HttpError(400, "name and type are required");
  const doc = await Room.create({ location: id, name: body.name, type: body.type, capacity: body.capacity, active: body.active ?? true });
  await audit({ entity: "Room", entityId: doc._id, newValue: "created", actor: user.id });
  return NextResponse.json({ item: doc }, { status: 201 });
});
