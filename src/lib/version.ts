// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-44";
export const RELEASE_NOTE =
  "Checker round five, the S1 trio. QA-097/098: one shared date parser for " +
  "every importer - DD-MM-YYYY (the template's own format, day-first even when " +
  "ambiguous), ISO, and Excel serials all read; an unreadable date is reported " +
  "BY ROW, never guessed, never silently dropped. QA-088: tc_password is the " +
  "Admin's alone - the old locations.manage gate handed the live government " +
  "portal password to every SPOC and Operations login. QA-085/086: the green " +
  "'Qualified for assessments' mark now comes from PORTAL hours alone; a " +
  "slot-less batch estimates nothing (never an assumed 8 hrs/day), our own " +
  "hours get their own column labelled est., and the student portal says " +
  "'estimated' out loud while its verdict waits for the portal meter.";
