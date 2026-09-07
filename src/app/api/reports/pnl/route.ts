import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { requireFinance } from "@/lib/permissions";
import { pnlRollup, type PnlFilters } from "@/lib/rules";

// QA-1831 — the revenue half of the money loop: earned, invoiced, received, and what it cost.
// A thin door, deliberately identical in shape to `/api/reports/costs`: every figure and every rule
// about how it is summed lives in `pnlRollup` (lib/rules.ts), so this screen and its .xlsx cannot
// drift into two different answers to the same question.
//
// `requireFinance(user, "view")` and nothing else. This endpoint's ENTIRE purpose is money, so it
// takes the DOOR rule — a 403 — rather than the field maskers, which exist for the mixed-audience
// surfaces (`/api/home`, the closure payload, the audit trail) that must still serve a caller with
// no finance right. `finance.view` is one of the two keys in `NO_ADMIN_BYPASS`, so an Admin who was
// never granted it is refused here exactly like anybody else — the CEO's own rule:
// *"चाहे सुपर एडमिन हो, सुपर एडमिन का काका हो।"*
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requireFinance(user, "view");

  const p = req.nextUrl.searchParams;
  const filters: PnlFilters = {};
  for (const k of ["from", "to", "location", "program", "scheme", "batch"] as const) {
    const v = p.get(k);
    if (v) filters[k] = v;
  }
  // `locationFilter` answers WHOSE; `requireFinance` answered WHETHER. A named `?location=` is
  // intersected inside `pnlRollup` against this clause and 403s if it falls outside — never
  // overwritten (QA-1898: that exact defect shipped once already, on the KPI door).
  return NextResponse.json(await pnlRollup(locationFilter(user), filters));
});
