// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-84";
export const RELEASE_NOTE =
  "QA-146 part 2 rider: candidates get the QA-130 delete verb. The CHI-ITI " +
  "import had left three of the sheet's own header/description rows in the " +
  "candidate list and there was no way to remove them (405). Admin-only, " +
  "refuses anyone with batch history (drop them from the batch instead), " +
  "documents cascade, audited by name. Delete button in the edit drawer for " +
  "Admin. Everything from -83 (role-scoped screens, template-row import " +
  "guard, streamed Range file reads, batch-bound retry queue, certificates " +
  "through the storage adapter) is unchanged.";
