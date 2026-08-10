import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { LocationTarget, Program } from "@/models";
import { capacitySummary } from "@/lib/rules";
import { audit } from "@/lib/audit";

// GET: targets for a location with capacity math (§5)
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  assertLocationInScope(user, id);
  const targets = await LocationTarget.find({ location: id }).populate("program").lean<any[]>();
  const items = targets.map((t) => ({
    ...t,
    capacity: t.program ? capacitySummary(t.approved_target, t.program) : null,
  }));
  return NextResponse.json({ items });
});

// PUT: upsert a target row { program, approved_target?, allocated_target?, start_date?, end_date? }
export const PUT = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  assertLocationInScope(user, id);
  const body = await req.json();
  if (!body.program) throw new HttpError(400, "program is required");
  const program = await Program.findById(body.program).lean<any>();
  if (!program) throw new HttpError(400, "Program not found");
  const set: Record<string, unknown> = {};
  for (const f of ["approved_target", "allocated_target", "start_date", "end_date"]) {
    if (body[f] !== undefined) set[f] = body[f];
  }
  const doc = await LocationTarget.findOneAndUpdate(
    { location: id, program: body.program },
    { $set: set },
    { upsert: true, new: true },
  );
  await audit({ entity: "LocationTarget", entityId: doc._id, field: "target", newValue: set, actor: user.id });
  return NextResponse.json({ item: doc });
});
