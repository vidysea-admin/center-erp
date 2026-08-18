import { NextResponse } from "next/server";
import { RELEASE, RELEASE_NOTE } from "@/lib/version";
import { storageHealth } from "@/lib/storage";

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
    // QA-145: is evidence storage durable on this build? No secrets — lets a read-only smoke (and
    // the checker) see whether uploads survive the next deploy.
    // QA-218 (checker sweep 18/08): this said "drive" whenever storage was configured at all, so
    // production reported Drive while it has actually run on GCS via Workload Identity Federation
    // since -9x. The endpoint exists to be trusted from outside; it now names the real backend.
    evidence_storage: storageHealth().backend === "local" ? "local-ephemeral" : storageHealth().backend,
  }, { headers: { "Cache-Control": "no-store" } });
}
