import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, readJson, HttpError } from "@/lib/authz";
import { digestTick } from "@/lib/daily-digest";
import { istDayOf } from "@/lib/rules";

// TEST-ONLY clock door for the daily digest (mtg-c1). Every test env runs with SCHEDULER_DISABLED=1, so
// the 21:00 tick never fires on its own; this runs ONE tick as if the clock read `now` and the caller
// were container `instance`, so a suite can put the clock at 20:59 and 21:00 and race two "containers".
// Same two independent gates as /api/test/reset-sms-cap: it 404s unless MONGODB_DB is a center_erp_ci*
// test database (checked FIRST, so in production the route does not exist), and it needs an Admin session.
// It also returns the mail text it composed per recipient, which the real tick does not.
export const POST = apiHandler(async (req: NextRequest) => {
  if (!/^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "")) throw new HttpError(404, "Not found");
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin");
  const body = await readJson(req);
  const now = body?.now ? new Date(body.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new HttpError(400, "now must be an ISO instant");
  // `skip_lock`: race ticks WITHOUT the efficiency lock, so the per-recipient claims alone must give exactly-once.
  // `simulate`: the outcome of attempt 1, 2, 3 ("sent" | "failed" | "skipped"), because every test env suppresses
  // mail and a genuine sent/failed cannot happen there. Both exist only behind the two gates above.
  const simulate = Array.isArray(body?.simulate) ? body.simulate.map(String) as Array<"sent" | "failed" | "skipped"> : undefined;
  if (simulate?.some((x: string) => !["sent", "failed", "skipped"].includes(x))) throw new HttpError(400, "simulate must be a list of sent | failed | skipped");
  const r = await digestTick({ now, instance: String(body?.instance || "test-door"), includeText: true, skipLock: body?.skip_lock === true, simulate });
  return NextResponse.json({ ...r, today_ist: istDayOf(now) });
});
