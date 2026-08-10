import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, locationFilter } from "@/lib/authz";
import { CostEntry } from "@/models";
import { assertCostEntryValid } from "@/lib/rules";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations"); // Rule 40 (Costs screen: Operations and Admin)
  const sp = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = { ...locationFilter(user) };
  for (const k of ["location", "batch", "trainer", "category"]) {
    const v = sp.get(k);
    if (v) filter[k] = v;
  }
  const items = await CostEntry.find(filter)
    .sort({ entry_date: -1 })
    .populate("location", "name code").populate("batch", "code").populate("trainer", "name").populate("category", "name").populate("entered_by", "name")
    .lean();
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations");
  const body = await req.json();
  assertCostEntryValid(body); // Rule 37
  const doc = await CostEntry.create({
    entry_date: body.entry_date ?? new Date(),
    location: body.location || undefined, batch: body.batch || undefined, trainer: body.trainer || undefined,
    category: body.category, amount: body.amount, note: body.note,
    entered_by: user.id,
  });
  await audit({ entity: "CostEntry", entityId: doc._id, newValue: "created", actor: user.id });
  return NextResponse.json({ item: doc }, { status: 201 });
});
