import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { requireFinance } from "@/lib/permissions";
import { COST_FILTER_KEYS, costRollup, parseCostFilters, type CostFilters } from "@/lib/rules";
import { ApprovalRequest, CostEntry } from "@/models";
import { Types } from "mongoose";

// QA-1830 — Manish sir's finance dashboard, server-side. A thin door on purpose: every figure and
// every rule about how it is summed lives in `costRollup` (lib/rules.ts), so this screen and its
// .xlsx cannot drift into two different answers to the same question.
//
// `requireFinance(user, "view")` and nothing else. This endpoint's ENTIRE purpose is money, so it
// takes the DOOR rule — a 403 — rather than the field maskers, which exist for the mixed-audience
// surfaces (`/api/home`, the closure payload, the audit trail) that must still serve a caller with
// no finance right. `finance.view` is one of the two keys in `NO_ADMIN_BYPASS`, so an Admin who was
// never granted it is refused here exactly like anybody else — which is the CEO's own rule:
// *"चाहे सुपर एडमिन हो, सुपर एडमिन का काका हो।"*
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requireFinance(user, "view");

  // ONE filter object (developer note #4), read here and applied server-side inside `costRollup`,
  // never in the UI (note #7). It travels back in the payload so the screen and the export can both
  // state what was counted.
  const p = req.nextUrl.searchParams;
  const filters: CostFilters = parseCostFilters(p, COST_FILTER_KEYS);
  // `locationFilter` answers WHOSE; `requireFinance` answered WHETHER. Both are needed: a scoped
  // finance user is a real thing, and a named `?location=` inside `costRollup` intersects this
  // clause rather than overwriting it (QA-1898 — the same defect, one release ago, on the KPI door).
  const rollup: any = await costRollup(locationFilter(user), filters);
  // mtg-b3 R10: say which register rows the caller entered themselves, so the screen can offer them
  // Edit / Delete (their own, until paid). The id of the enterer itself is not sent on.
  const costIds = (rollup.register ?? []).map((r: any) => r.id ?? r._id).filter((id: any) => Types.ObjectId.isValid(String(id)))
    .map((id: any) => new Types.ObjectId(String(id)));
  const [waiting, owners] = costIds.length ? await Promise.all([
    ApprovalRequest.find({ action: "cost.post", entity_id: { $in: costIds },
      status: { $in: ["Pending", "Applying"] }, "payload.kind": "cost-edit" }).select("entity_id").lean<any[]>(),
    CostEntry.collection.find({ _id: { $in: costIds }, cost_edit_request: { $ne: null } }, { projection: { _id: 1 } }).toArray(),
  ]) : [[], []];
  const waitingIds = new Set([...waiting.map((r: any) => String(r.entity_id)), ...owners.map((r: any) => String(r._id))]);
  rollup.register = (rollup.register ?? []).map(({ entered_by_id, ...row }: any) => ({
    ...row, is_mine: !!entered_by_id && entered_by_id === String(user.id),
    edit_pending: waitingIds.has(String(row.id ?? row._id)),
  }));
  return NextResponse.json(rollup);
});
