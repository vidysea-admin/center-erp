import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
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
  const body = await req.json().catch(() => ({}));
  const now = body?.now ? new Date(body.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new HttpError(400, "now must be an ISO instant");
  const r = await digestTick({ now, instance: String(body?.instance || "test-door"), includeText: true });
  return NextResponse.json({ ...r, today_ist: istDayOf(now) });
});
