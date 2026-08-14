// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-55";
export const RELEASE_NOTE =
  "QA-125 (S2, checker live-proof): a location-scoped user could edit, " +
  "document and un-document a trainer their own list refused to show " +
  "them - the seventh list-hides/item-allows hole and the first on " +
  "writes. The list's nomination/capability/home union now guards EVERY " +
  "by-id trainer surface (detail, edit, documents read/attach/delete, " +
  "pipeline moves), a trainer tied to no centre fails closed, and a " +
  "scoped user can only create or import trainers tied to their own " +
  "centre - quick-invite auto-ties the invitee so the inviter can see " +
  "them. Sweep riders: a centre-less government-attendance import no " +
  "longer slips past scope, and the trainer-request detail honours the " +
  "same reader list as its own list.";
