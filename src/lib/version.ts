// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-16";
export const RELEASE_NOTE =
  "Trainer bulk import (Manish template #3): upload -> map -> preview -> confirm, " +
  "same shape as the candidate importer. Stages accept the display names (Fresh " +
  "Lead, TOT Payment Done...), nominations resolve by centre/job-role NAME, and " +
  "everything unresolvable - unknown stages, unmatched names, Certified rows " +
  "without a TR ID, duplicate phones - is reported by name and left blank or " +
  "flagged, never guessed. Halted centres never receive a nomination (F-B5).";
