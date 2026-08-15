// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-83";
export const RELEASE_NOTE =
  "QA-153 + QA-146 part 2 + QA-154/155/156. Umesh: 'unko bas itna dikhe jahan " +
  "unka kaam hai' - one rule (routeAllowed) now decides whether a door EXISTS: " +
  "the sidebar and the route itself obey it, effective rights from " +
  "/api/permissions/me override the role list, and a screen outside a role's " +
  "work renders a plain closed door instead of a form the API would refuse; " +
  "Costs stops asking Operations for the invoice book. The candidate importer " +
  "skips a sheet's own column-number/header/description rows and names them " +
  "by row. File reads STREAM with Range (206) and real media types - video " +
  "seeks, iOS plays, voice notes play inline; a bulk-uploaded certificate " +
  "goes through the same storage adapter as every other file (StoredFile row, " +
  "Drive when on). Every evidence upload says where it belongs (centre/batch/" +
  "kind + entity), and the offline retry queue is bound to its batch - a parked " +
  "photo can no longer land on another batch's log.";
