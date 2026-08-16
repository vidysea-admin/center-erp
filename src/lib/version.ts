// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-97";
export const RELEASE_NOTE =
  "-97: QA-162 compress FIRST then route (device image/video compression is size-blind; " +
  "size still decides direct-vs-proxied); QA-164 a skipped/failed device compression " +
  "travels as its reason and the screen says so (no more 'compressed on your phone' over " +
  "a 570 MB upload; unmuted-play refusal now retries muted instead of giving up); file " +
  "lifecycle: deleting a candidate/trainer document or replacing a certificate deletes " +
  "the stored object too and the URL answers 410; a wrong photo/video can be discarded " +
  "before Save (uploader-only, unreferenced); Admin 'Files' table shows where every " +
  "upload lives (<Centre>/<Batch>/<kind>) with a Google Cloud console link; bucket CORS " +
  "= production origin only.";
