import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { getDefaults } from "@/lib/defaults";
import { assertDigestDay, dailyDigest, istDayOf } from "@/lib/rules";
import { DIGEST_HOUR_IST, digestHealth } from "@/lib/daily-digest";

// mtg-c1 (R4): the daily digest as data - the screen /reports/daily reads this, and the 21:00 mail and
// Publish now are built by the SAME `dailyDigest` (lib/rules.ts). A thin door on purpose: every number,
// the centre scope and the finance gate live in that one function. Trainer logins are not part of this
// report (they are people who work at centres, not people who read the position of the programme).
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations", "Location", "Enrollment");
  const day = assertDigestDay(req.nextUrl.searchParams.get("date") || istDayOf());
  // digestHealth only feeds the warning and the counts in `meta`: a failure there must not take the report down for a reader.
  const [digest, defaults, health] = await Promise.all([dailyDigest(day, user), getDefaults(), digestHealth().catch(() => ({ digest_only: false, recipients: 0, deliverable: 0, digest_only_nobody: false }))]);
  // `meta` lets the screen say so when the mail cannot actually leave (email_enabled off, nobody listed).
  // It carries counts of recipients, not their addresses. `digest_only_nobody` (checker A2): digest-only is ON and no
  // listed recipient can receive the digest, so the approval mails are going nowhere; the screen says so in red.
  return NextResponse.json({
    ...digest,
    meta: { email_enabled: defaults.email_enabled !== false, recipients: health.recipients, deliverable: health.deliverable, digest_only: health.digest_only, digest_only_nobody: health.digest_only_nobody, hour: DIGEST_HOUR_IST },
  });
});
