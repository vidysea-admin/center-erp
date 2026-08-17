// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-101";
export const RELEASE_NOTE =
  "-101: the D of CRUD for evidence files. A certificate could be uploaded and replaced but " +
  "never removed, so a scan attached to the wrong candidate was permanent and its stored object " +
  "could never be reclaimed - DELETE /api/results/<id>/certificate now removes the file (status, " +
  "number and date stay: Rule 46 owns those), refuses on a Completed batch, and is audited with " +
  "the reason. Three storage leaks closed with it: re-uploading the same document type used to " +
  "leave the superseded file readable and unreferenced in the bucket; the storage health probe " +
  "left a _healthcheck object behind on every run with no way to remove it; and the discard door " +
  "missed Closure.result_file and CandidateResult.evidence_file, so a file a record still showed " +
  "could be discarded out from under it.";
