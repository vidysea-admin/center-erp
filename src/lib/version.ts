// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-34";
export const RELEASE_NOTE =
  "R-B user management (CEO: 'right away'). Per-user REMOVED rights: a deny " +
  "list that wins over the role's set AND any extra grant - Admin edits it on " +
  "the user drawer ('Removed rights', red), non-Admins cannot touch it, and the " +
  "refusal names the missing right. One-click 'Stop access' / 'Reactivate' on " +
  "every user row - a stopped account cannot mint a new session. (Rides with " +
  "R-A from -33: CEO stage vocabulary stored, Dropout/Failed journey stages, " +
  "enrolled_at stamp, wipe endpoint removed.)";
