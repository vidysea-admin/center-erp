import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { RELEASE, RELEASE_NOTE_CURRENT } from "@/lib/version";
import { storageHealth } from "@/lib/storage";

// -249 (QA-1202): WHICH TREE IS THIS, not just which release name.
//
// `RELEASE` is hand-bumped, so it answers a question nobody asked: what the last person to edit
// version.ts intended. On 2026-08-25 production served FOUR commits past the marker it announced,
// and the same string `-246` truthfully named two different trees within one afternoon - one where
// QA-1145 was a live defect and one where it was fixed. Both claims cited `-246` and both were
// right. Every `validated_on_release` stamp written in that window is unfalsifiable.
//
// `commit` has been in this payload all along and was null until -249, because nothing ever set
// GIT_COMMIT: `.dockerignore` excludes `.git`, so the image genuinely cannot derive it, and the
// buildspec that could pass it lives in AWS CodeBuild, not in this repo. That is a devops action;
// the Dockerfile now declares the ARG so it is a one-line change whenever someone takes it.
//
// So this publishes the identity the image ALREADY carries and nobody was reading: Next writes a
// fresh BUILD_ID for every build, the standalone output copies it to `.next/BUILD_ID`, and the
// Dockerfile copies that to `/app/.next/BUILD_ID`. It does NOT name a commit and is no substitute
// for GIT_COMMIT - but it changes whenever the built tree changes, which answers the question
// `release` cannot: is this the same build I checked ten minutes ago?
//
// Read once at module load, never on the request path, and every failure is swallowed - this
// endpoint's whole value is answering when everything else is broken. `next dev` has no BUILD_ID
// and correctly reports null.
const BUILD_ID: string | null = (() => {
  try {
    const v = readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
})();

// Public build marker — no auth, no database. Its only job is to answer
// "which build is actually running right now?" so a deploy can be verified from outside:
//     curl https://www.vidysea.com/erp/api/public/version
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    release: RELEASE,
    // -127 (QA-265): this published RELEASE_NOTE, which for an unknown number of releases was 97
    // characters because the constant's continuation lines carried no `+` and ASI dropped all but
    // the first. Joining them fixed the constant and would have published a 32 KB internal archive
    // - forty releases of commentary quoting Manish and Umesh by name, naming ledger ids and
    // describing what was recently broken - from an endpoint with no auth. This endpoint's job, in
    // its own words above, is "which build is actually running right now?", so it answers exactly
    // that: what THIS build changed. The archive stays in the bundle for anyone with the source.
    note: RELEASE_NOTE_CURRENT,
    // -250 (QA-1309, the checker's cycle-2 FAIL): `??` only catches null/undefined, and -249's own
    // Dockerfile change made this variable ALWAYS SET — `ARG GIT_COMMIT=""` plus
    // `ENV GIT_COMMIT=$GIT_COMMIT` means an unwired pipeline exports an EMPTY STRING, not nothing.
    // So production on -249 answered `"commit":""` while this file, OPERATIONS.md and e2e.mjs all
    // said it answers `null`, and wait-for-release.mjs printed a blank where it used to print
    // "(not set)". `||` collapses the empty string back to null, which is both what those three
    // documents promise and the honest reading: a variable set to nothing is not a commit.
    // The unit that introduced the empty string is the unit that documented it as null — the fix
    // shipped and the sentence describing it did not move.
    commit: process.env.GIT_COMMIT || null,
    // -249 (QA-1202): changes on every build even when `release` and `commit` do not. Two responses
    // with the same `release` and a different `build_id` are two different BUILDS.
    // -250 (QA-1270, the checker's FAIL against cycle 1): this said "two different TREES, full stop",
    // and the checker disproved it with this unit's own headline step - three builds of byte-identical
    // source gave three different ids. Next generates the id per BUILD, so a CodeBuild retry of the
    // same commit changes it while the source has not moved. Different id => rebuilt/redeployed;
    // it does NOT mean the code changed. Only `commit` answers that, and only once CodeBuild passes
    // it. A unit whose whole purpose is making deploy claims falsifiable must not ship an
    // unfalsifiable rule about its own signal.
    build_id: BUILD_ID,
    server_time: new Date().toISOString(),
    // QA-145: is evidence storage durable on this build? No secrets — lets a read-only smoke (and
    // the checker) see whether uploads survive the next deploy.
    // QA-218 (checker sweep 18/08): this said "drive" whenever storage was configured at all, so
    // production reported Drive while it has actually run on GCS via Workload Identity Federation
    // since -9x. The endpoint exists to be trusted from outside; it now names the real backend.
    evidence_storage: storageHealth().backend === "local" ? "local-ephemeral" : storageHealth().backend,
  }, { headers: { "Cache-Control": "no-store" } });
}
