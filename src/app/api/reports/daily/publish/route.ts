import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, readJson, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { assertDigestDay, istDayOf } from "@/lib/rules";
import { publishDigestNow } from "@/lib/daily-digest";

// mtg-c1 (R4): "Publish now" - mail the daily digest to the configured recipients immediately. It sends
// mail on behalf of the company, so it sits behind the same right as the setting that decides who the
// recipients are: `defaults.manage` (Admin by default, grantable). The mail itself goes through the one
// door, `sendMail`, which still honours `email_enabled`: this route does not turn mail on.
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "defaults.manage");
  const body = await readJson(req);
  const day = assertDigestDay(body?.date || istDayOf());
  const r = await publishDigestNow(day, user);
  if (r.status !== 200) throw new HttpError(r.status, r.error);
  const { status: _s, ...out } = r;
  return NextResponse.json(out);
});
