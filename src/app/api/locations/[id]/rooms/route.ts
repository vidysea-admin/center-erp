import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { Room } from "@/models";
import { requireApproval } from "@/lib/approvals";
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
  // QA-075 (CEO [36:52-37:28]): a SPOC "should be able to add number of classrooms … number
  // of labs … once they do that, let us send it for the approval to the admin" — the same
  // location.edit parking as their field edits (direct while the rule is off).
  if (user.role === "Location") {
    const gate = await requireApproval("location.edit", user, {
      entity: "Location", entity_id: id, location: id,
      summary: `${user.name} suggests adding a ${String(body.type).toLowerCase()}: ${body.name}${body.capacity ? ` (capacity ${body.capacity})` : ""}`,
      payload: { room: { name: body.name, type: body.type, capacity: body.capacity } },
    });
    if (gate) return NextResponse.json({ queued: true, item: gate.request }, { status: 202 });
  }
  const doc = await Room.create({ location: id, name: body.name, type: body.type, capacity: body.capacity, active: body.active ?? true });
  await audit({ entity: "Room", entityId: doc._id, newValue: "created", actor: user.id });
  return NextResponse.json({ item: doc }, { status: 201 });
});
