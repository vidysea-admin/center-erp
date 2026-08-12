import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, isScoped } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { findDuplicateCandidates } from "@/lib/duplicates";

// Rule 7: advisory duplicate lookup used by the Add Candidate form as the user types.
// Returns matches; it never blocks — the caller decides whether to proceed.
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // 2026-08-12 audit (auth S2-12): an unscoped, unrated oracle — any signed-in user could
  // probe a phone number against every centre in the country and read back the matching
  // candidate. It is an aid to the Add Candidate form, so it answers to the same right, and
  // a scoped user only ever learns about their own centres.
  await requirePerm(user, "candidates.manage");
  const { name, phone, dob, exclude } = await req.json();
  const duplicates = await findDuplicateCandidates(
    { name, phone, dob }, exclude,
    isScoped(user) ? (user.location_scope ?? []).map(String) : undefined,
  );
  return NextResponse.json({ duplicates });
});
