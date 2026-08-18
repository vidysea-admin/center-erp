import { NextResponse } from "next/server";
import { RELEASE, RELEASE_NOTE_CURRENT } from "@/lib/version";
import { storageHealth } from "@/lib/storage";

// Public build marker — no auth, no database. Its only job is to answer
// "which build is actually running right now?" so a deploy can be verified from outside:
//     curl https://www.vidysea.com/erp/api/public/version
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    release: RELEASE,
    // -127 (QA-181): this published RELEASE_NOTE, which for an unknown number of releases was 97
    // characters because the constant's continuation lines carried no `+` and ASI dropped all but
    // the first. Joining them fixed the constant and would have published a 32 KB internal archive
    // - forty releases of commentary quoting Manish and Umesh by name, naming ledger ids and
    // describing what was recently broken - from an endpoint with no auth. This endpoint's job, in
    // its own words above, is "which build is actually running right now?", so it answers exactly
    // that: what THIS build changed. The archive stays in the bundle for anyone with the source.
    note: RELEASE_NOTE_CURRENT,
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
