import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { CostCategory, DropReason, FailureReason } from "@/models";

const LISTS: Record<string, any> = { "cost-categories": CostCategory, "drop-reasons": DropReason, "failure-reasons": FailureReason };

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
  const name = String(body.name ?? "").trim();
  if (!name) throw new HttpError(400, "name required");
  // F-B17 (2026-08-14): "Trainer Fee" and "Trainer fee" both existed in production and
  // the trainer-fee auto-suggest matched neither reliably. Names are unique per list,
  // case-insensitively — the refusal names the existing entry so the fix is obvious.
  const dupe = await Model.findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } }).lean();
  if (dupe) throw new HttpError(409, `"${dupe.name}" already exists in this list — names are unique (case-insensitive).`);
  const item = await Model.create({ name, active: body.active ?? true });
  return NextResponse.json({ item }, { status: 201 });
});
