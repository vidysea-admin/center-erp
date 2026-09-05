import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, locationFilter } from "@/lib/authz";
import { requirePerm, requireFinance } from "@/lib/permissions";
import { CostEntry } from "@/models";
import { assertCostEntryValid } from "@/lib/rules";
import { requireApproval } from "@/lib/approvals";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // R-E (CEO 14/08 [25:06]): whoever POSTS money entries "shouldn't be able to see what has been
  // posted" — the ledger is a narrower right than the form. Their own submissions stay visible via
  // /api/approvals?mine=1, never the book.
  //
  // QA-1825 (CEO, 2026-09-05): that shape is unchanged; what changed is that it is no longer a
  // hardcoded role name. The old line read `if (user.role === "Operations") throw 403`, written
  // because "an ordered none<view<edit lattice cannot express edit-without-view". Splitting the
  // right instead of stretching the lattice expresses it exactly — costs.manage is the form,
  // finance.view is the book — and the CEO has since widened the rule far past Operations:
  // "kisi ke bhi paas nahi hogi chaahe super admin ho." An Admin without the grant now 403s here
  // too, which the role hardcode could never have done.
  await requireFinance(user, "view");
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
