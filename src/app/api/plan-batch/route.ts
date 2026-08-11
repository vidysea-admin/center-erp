import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { planBatchBackward } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";

// Standalone backward-plan calculator (2026-08-11): "मैं जब चाहूं… एक batch planning निकाल
// के किसी को भी share कर सकूं" — pick a start date, get the checklist, before any batch
// exists. GET ?start=YYYY-MM-DD
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  await requireUser();
  const start = req.nextUrl.searchParams.get("start");
  if (!start || isNaN(new Date(start).getTime())) throw new HttpError(400, "start (YYYY-MM-DD) is required");
  const defaults = await getDefaults();
  const milestones = planBatchBackward(new Date(start), defaults);
  return NextResponse.json({ start, milestones });
});
