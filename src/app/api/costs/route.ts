import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, locationFilter, HttpError } from "@/lib/authz";
import { requirePerm, requireView } from "@/lib/permissions";
import { CostEntry } from "@/models";
import { assertCostEntryValid } from "@/lib/rules";
import { requireApproval } from "@/lib/approvals";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // QA-025 P2: reading the ledger needs the VIEW level; posting keeps needing edit below.
  await requireView(user, "costs.manage");
  // R-E (CEO 14/08 [25:06]): Operations POSTS money entries but "shouldn't be able to see
  // what has been posted" — the ledger lives with the Admin. Their own submissions are
  // visible via /api/approvals?mine=1, never the book. This hardcode STAYS by design: an
  // ordered none<view<edit lattice cannot express edit-without-view, and the CEO asked for
  // exactly that shape here (checker re-verified 16/08 — [24:42] + [25:06]).
  if (user.role === "Operations") {
    throw new HttpError(403, "Operations posts entries for approval; the cost ledger is Admin-only. Your own submissions are under My submissions.");
  }
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
  await requirePerm(user, "costs.manage");
  requireEdit(user); // Rule 39: can_edit=false is view-only everywhere, including granted rights
  const body = await req.json();
  assertCostEntryValid(body); // Rule 37
  // R-E: when the cost.post approval rule is enabled, a non-approver's entry PARKS instead
  // of writing the ledger — the CostEntry is created only by the approval replay. Admin (as
  // the configured approver) passes straight through, exactly as before.
  const parked = await requireApproval("cost.post", user, {
    entity: "CostEntry",
    summary: `Cost entry ₹${body.amount} (${user.name})${body.note ? ` — ${body.note}` : ""}`,
    payload: body,
    location: body.location || undefined,
  });
  if (parked) return NextResponse.json({ queued: true, item: parked.request }, { status: 202 });
  const doc = await CostEntry.create({
    entry_date: body.entry_date ?? new Date(),
    location: body.location || undefined, batch: body.batch || undefined, trainer: body.trainer || undefined,
    category: body.category, amount: body.amount, note: body.note,
    entered_by: user.id,
  });
  await audit({ entity: "CostEntry", entityId: doc._id, newValue: "created", actor: user.id });
  return NextResponse.json({ item: doc }, { status: 201 });
});
