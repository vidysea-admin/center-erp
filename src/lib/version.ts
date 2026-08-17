// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-99";
export const RELEASE_NOTE =
  "-99: QA-159 (second half) the batches list can finally answer \"which batch has " +
  "attendance, and for how many days\" when the attendance came from the government " +
  "portal. The row read \"0 days\" in bold with \"(36)\" beside it, and 36 was the number " +
  "of STUDENTS matched, never days. The row now carries the portal's own working-day " +
  "meter: \"0 days ours\" and \"portal 13 days - 36 students\", it sorts on whichever " +
  "source actually has days, and unmatched portal rows are ignored.";
