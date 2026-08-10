import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { CostCategory, DropReason } from "@/models";

const LISTS: Record<string, any> = { "cost-categories": CostCategory, "drop-reasons": DropReason };

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ list: string }> }) => {
  await dbConnect();
  await requireUser();
  const { list } = await ctx.params;
  const Model = LISTS[list];
  if (!Model) throw new HttpError(404, "Unknown list");
  const items = await Model.find({}).sort({ name: 1 }).lean();
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ list: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin"); // Rule 40
  const { list } = await ctx.params;
  const Model = LISTS[list];
  if (!Model) throw new HttpError(404, "Unknown list");
  const body = await req.json();
  if (!body.name) throw new HttpError(400, "name required");
  const item = await Model.create({ name: body.name, active: body.active ?? true });
  return NextResponse.json({ item }, { status: 201 });
});
