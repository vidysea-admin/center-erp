import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { recentlyApprovedTargets } from "@/lib/rules";

// mtg-b1 (R1a) - the "Recently approved" strip on /reports. A thin door: the window, the verdict and
// the grouping all live in `recentlyApprovedTargets` (lib/rules.ts). Rule 38, exactly as
// /api/reports/rollup does it: `locationFilter(user)` goes straight into the query, so a centre login
// is told about its own centres only.
//
// `?days=N` (default 7). A missing or non-numeric value falls back to the default rather than
// failing - an odd query string must never take down a report the CEO opens.
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  const days = Number(req.nextUrl.searchParams.get("days"));
  return NextResponse.json(await recentlyApprovedTargets(locationFilter(user), { days }));
});
