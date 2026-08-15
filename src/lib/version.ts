// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-77";
export const RELEASE_NOTE =
  "QA-145 evidence storage (S1). The checker proved every deploy wipes " +
  "the uploads dir (24/24 reads on -73, 16/16 404 after -74) while the " +
  "URLs stay in Mongo pointing at nothing. This build carries Umesh's " +
  "design, ready to switch on: a Google Drive adapter (service account, " +
  "folder-wise <Centre>/<Batch>/<kind>, the app proxies every read - the " +
  "user never sees Drive), a StoredFile row for EVERY upload (backend, " +
  "Drive id, folder path, size, uploader, entity), and an honest health " +
  "surface: /api/public/version says evidence_storage drive|local-" +
  "ephemeral, the admin panel shows RED 'NOT CONNECTED - lost on every " +
  "deploy' until the two env vars land. Graceful-off like mail: nothing " +
  "breaks unconfigured, nothing lies. Gate = Umesh: drive-storage-setup.md.";
