import { NextResponse } from "next/server";
import { RELEASE, RELEASE_NOTE } from "@/lib/version";

// Public build marker — no auth, no database. Its only job is to answer
// "which build is actually running right now?" so a deploy can be verified from outside:
//     curl https://www.vidysea.com/erp/api/public/version
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    release: RELEASE,
    note: RELEASE_NOTE,
    commit: process.env.GIT_COMMIT ?? null,
    server_time: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
