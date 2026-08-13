// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-8";
export const RELEASE_NOTE =
  "Locations = the OneDrive truth sheet: the list mirrors Vidysea-RPL.xlsx column-for-column " +
  "in its order (SPOC, cluster contact, state, district, institution, operational, partner, " +
  "scheme, job role, targets, enrolment claims, per-row TC id/password/status, trainer " +
  "required + the sheet's three claimed trainer counts), with our LIVE trainer fulfilment " +
  "derived from Trainer rows beside the claims — it updates the moment a pipeline moves. " +
  "Every table now has a Columns picker (only selected columns show; choice persists per " +
  "table). seed-rpl's default source is the OneDrive workbook again — Umesh: 'this one is " +
  "the only source of truth' — with the Google export demoted to --google comparison.";
