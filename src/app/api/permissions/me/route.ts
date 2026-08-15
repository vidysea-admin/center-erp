import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { getEffectiveLevels } from "@/lib/permissions";

// QA-025 P1: "what may I do here" for the signed-in user's own UI — buttons key on edit,
// tables on view. Own levels only; reading someone ELSE's rights stays the Admin screens' job.
export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  const levels = await getEffectiveLevels(user);
  return NextResponse.json({ role: user.role, levels: Object.fromEntries(levels) });
});
