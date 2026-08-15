// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-79";
export const RELEASE_NOTE =
  "QA-145 rider - the storage probe. Umesh asked the right question: was " +
  "the Drive path tested against real Google or just pushed? Honest " +
  "answer: without a service-account key that branch cannot run, so it " +
  "was compiled, not exercised. This build adds the mail panel's 'send " +
  "test mail' twin for storage: POST /api/test-storage writes a probe " +
  "under <root>/_healthcheck/, reads it back through the same proxy " +
  "path, and reports backend / Drive id / folder / round-trip match - " +
  "one click the moment the key lands. Refuses to run unconfigured (it " +
  "would only prove the disk deploys wipe). Also aligns code comments " +
  "with the checker's minted numbers (login link = QA-149, blocker " +
  "text = QA-148) and documents the Shared-Drive quota caveat.";
