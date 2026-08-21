import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { reportRollup } from "@/lib/rules";

// QA-398 — the high-level report Karunn sir asked for on 20 Aug, and the first of the two things
// he said the whole job needs ("aapki ek ye high level aur doosra batch planning").
//
// A thin door on purpose: every figure, every rule about summing rather than assigning, and every
// source label lives in `reportRollup` (lib/rules.ts), so the screen and the Excel export cannot
// drift into two different answers to the same question.
export const GET = apiHandler(async (_req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // Rule 38, the same filter every other screen uses. Karunn sir sees every row, a centre login
  // sees its own. Nothing new is invented here - a new scoping concept is a new way to get it
  // wrong, and this report has no scoping question of its own.
  return NextResponse.json(await reportRollup(locationFilter(user)));
});
