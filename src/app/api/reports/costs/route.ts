import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { requireFinance } from "@/lib/permissions";
import { costRollup, type CostFilters } from "@/lib/rules";

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
  const filters: CostFilters = {};
  for (const k of ["from", "to", "location", "batch", "trainer", "program", "category"] as const) {
    const v = p.get(k);
    if (v) filters[k] = v;
  }
  // `locationFilter` answers WHOSE; `requireFinance` answered WHETHER. Both are needed: a scoped
  // finance user is a real thing, and a named `?location=` inside `costRollup` intersects this
  // clause rather than overwriting it (QA-1898 — the same defect, one release ago, on the KPI door).
  return NextResponse.json(await costRollup(locationFilter(user), filters));
});
