import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { findDuplicateCandidates } from "@/lib/duplicates";

// Rule 7: advisory duplicate lookup used by the Add Candidate form as the user types.
// Returns matches; it never blocks — the caller decides whether to proceed.
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  await requireUser();
  const { name, phone, dob, exclude } = await req.json();
  const duplicates = await findDuplicateCandidates({ name, phone, dob }, exclude);
  return NextResponse.json({ duplicates });
});
