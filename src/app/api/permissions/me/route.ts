import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { getEffectiveLevels, NO_ADMIN_BYPASS } from "@/lib/permissions";

// QA-025 P1: "what may I do here" for the signed-in user's own UI — buttons key on edit,
// tables on view. Own levels only; reading someone ELSE's rights stays the Admin screens' job.
export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  const levels = await getEffectiveLevels(user);
  // QA-1825: `no_admin_bypass` travels WITH the payload rather than being retyped in shell.tsx.
  // The shell is "use client" and cannot import lib/permissions.ts (mongoose), and the two client
  // gates there (`usePerms().can` and `routeAllowed`) both short-circuit on Admin — so without
  // this they would have to carry their own copy of the exempt list, which is precisely the
  // second-copy fault ARCHITECTURE.md section 3 catalogues. Same device, same reason, as
  // rules.ts's REPORT_LABELS travelling to the report page.
  return NextResponse.json({
    role: user.role,
    levels: Object.fromEntries(levels),
    no_admin_bypass: [...NO_ADMIN_BYPASS],
  });
});
