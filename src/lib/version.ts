// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-53";
export const RELEASE_NOTE =
  "Checker round (15/08): QA-111 - the Move drawer now offers ONLY the " +
  "moves the pipeline will accept (the server's own edge table rides in " +
  "as allowed_next); no more picking Certified from Fresh Lead, typing a " +
  "TR ID and being refused. QA-112 - a document can be DELETED (audited: " +
  "what left, who removed it; the docs gate honestly reopens), so a " +
  "wrong Aadhaar/PAN file is no longer permanent - replace = delete + " +
  "upload again. QA-113 - the upload drawer copy is English and now " +
  "describes that real flow. And audio evidence uploads " +
  "(.mp3/.m4a/.wav/.amr) - voice notes are field evidence like photos.";
