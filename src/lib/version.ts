// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-38";
export const RELEASE_NOTE =
  "R-F: a SPOC helps with centre details, the Admin approves. The centre's " +
  "identity and master-sheet truth - ten fields: code, external/TC ids, name, " +
  "city, state, TC password/status, approval and operational status - are " +
  "FIXED for a centre login (403 naming the field). Everything else, including " +
  "'approved for a programme' target changes, PARKS as a location.edit " +
  "approval; the change is applied only by the Admin's approval, and the fixed " +
  "ten are stripped again at replay as the guarantee. Enable per environment: " +
  "approval rule location.edit (ships OFF by design).";
