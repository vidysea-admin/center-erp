// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-66";
export const RELEASE_NOTE =
  "QA-025 P1+P2: rights get three levels - none / view / edit. " +
  "Encoding is zero-migration: a bare key still means edit (its " +
  "meaning since day one), 'key:view' is the new middle level; " +
  "grants only upgrade, deny still wins, can_edit=false caps " +
  "everything at view (Rule 39 unchanged), Admin bypasses as always. " +
  "The admin matrix is tri-state per cell now; /api/permissions/me " +
  "tells a session its own levels. Enforcement phase 2: the finance " +
  "reads (cost ledger, invoice book, approvals queue) open at VIEW " +
  "level while every write keeps needing edit. The R-E Operations " +
  "hardcode stays by design - an ordered lattice cannot express the " +
  "CEO's post-yes/read-no shape.";
