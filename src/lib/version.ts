// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-92";
export const RELEASE_NOTE =
  "QA-161 (Umesh 16/08: 'gcs wala hi mere bhai'): evidence storage's decided " +
  "backend is Google Cloud Storage. Added as a third backend, not a rewrite: " +
  "GCS_BUCKET + GCS_SA_JSON (raw or base64) switch the app to GCS - preferred " +
  "over the Drive shapes when present; putFile/getFileStream/getFile, the " +
  "resumable session (same 308/Range protocol the -90 client speaks), " +
  "complete/abort and the health probe all serve it; the folder tree " +
  "<Centre>/<Batch>/<kind>/<name> is the object key; old local/drive rows keep " +
  "working. Env diagnostic lists the GCS names; Admin banner names the backend. " +
  "Setup for Umesh: D:/erp/gcs-storage-setup.md (bucket in asia-south1, SA with " +
  "Object Admin on the bucket, JSON key to devops next to SES_SMTP_USER). " +
  "Unproven against a real bucket until the key exists - the local proof " +
  "(96 MB, 607 MB, Range) runs the moment it does.";
