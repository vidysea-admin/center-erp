import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter, assertLocationInScope } from "@/lib/authz";
import { LocationTarget } from "@/models";
import { mappingReadiness } from "@/lib/rules";

// The three-way mapping, 2026-08-12 (Manish): "ye teen cheezein hain - location, trainer, aur
// candidate. Ye teeno map ho gaye to batch form ho jata hai."
//
// One row per centre x job role that has a target, answering the only question that matters
// before a batch can exist: is this combination ready, and if not, what is the ONE thing to fix?
//
// GET ?location=<id>            — every job role at one centre
// GET ?ready=1                  — only the combinations that can start today
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  const sp = req.nextUrl.searchParams;

  const filter: Record<string, unknown> = { ...locationFilter(user) }; // Rule 38
  const loc = sp.get("location");
  if (loc) {
    assertLocationInScope(user, loc); // narrowing only — can never widen past scope
    filter.location = loc;
  }

  // Targets are the definitive list of what each centre is contracted to deliver, so they are
  // the right spine for this view — a centre with no target has nothing to be ready for.
  const targets = await LocationTarget.find(filter).select("location program").limit(400).lean<any[]>();

  const rows = [];
  for (const t of targets) {
    try {
      rows.push(await mappingReadiness(String(t.location), String(t.program)));
    } catch {
      // A target pointing at a deleted location or programme should not break the whole screen.
      continue;
    }
  }

  const readyOnly = sp.get("ready") === "1";
  const items = readyOnly ? rows.filter((r) => r.ready) : rows;
  // Blocked first, and within that the ones closest to starting — that is the work queue order.
  items.sort((a, b) => Number(a.ready) - Number(b.ready) || a.blockers.length - b.blockers.length);

  return NextResponse.json({
    items,
    total: items.length,
    ready_count: rows.filter((r) => r.ready).length,
    blocked_count: rows.filter((r) => !r.ready).length,
  });
});
