import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/authz";

// 2026-08-14 (CEO 13/08): public STAFF signup is CLOSED — "SPOC/Operations hum banayenge
// peeche se; koi request nahi bhejega mujhe. Signup mein keval candidates; trainer ka
// alag slash." Candidates use /p/me (phone lookup) or a per-location register link;
// trainers apply at /p/trainer-apply; staff accounts are created in Admin → Users.
// The route answers 410 GONE (not 404) so old bookmarks/scripts learn WHY, and points at
// the right doors. The old open-role signup created pending Users — that path is retired.
const GONE = {
  error: "Self-signup is closed. Candidates: use the candidate portal (/p/me). Trainers: apply at /p/trainer-apply. Staff accounts are created by the Admin.",
  candidate_portal: "/p/me",
  trainer_apply: "/p/trainer-apply",
};

export const GET = apiHandler(async () => NextResponse.json(GONE, { status: 410 }));
export const POST = apiHandler(async () => NextResponse.json(GONE, { status: 410 }));
