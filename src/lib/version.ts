// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-78";
export const RELEASE_NOTE =
  "QA-148 trainer login bridge (Manish: 'Add Trainer se banaya, Certified, " +
  "batch assign - login karun to batch dikhta hi nahi'). Trainer.user was " +
  "declared on 2026-08-11 and NOTHING ever set it: Add Trainer made no " +
  "login, Add User linked no trainer, so is_mine was false for every " +
  "trainer alive and the batch list opened on an empty 'My batches'. Now: " +
  "one resolver (explicit link, else same email - self-healed onto the " +
  "record) is how a login becomes a trainer; a trainer's ASSIGNED batches " +
  "are always in their list and openable, whatever the login's scope; the " +
  "trainer page has a 'Create login' button (scoped to every centre they " +
  "are tied to or teach at, one-time temporary password shown once, never " +
  "mailed); Add User with role Trainer + a trainer's email auto-links. " +
  "Rider (Umesh: 'Drive link hard code kar de'): the Drive root folder is " +
  "the code default now - only the service-account key remains his gate.";
