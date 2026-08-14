// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-35";
export const RELEASE_NOTE =
  "R-C daily-log date guard (Rule 53, CEO: 'today, maximum minus one, " +
  "definitely not plus one'). Attendance can never be taken for a future date - " +
  "any role; a Trainer may write only today or yesterday (IST calendar day, not " +
  "the server's UTC day), with older corrections left to Operations/Admin. The " +
  "date picker mirrors the rule, and the govt-attendance-screenshot upload " +
  "leaves the Trainer's form (CEO: they won't have it) while Ops/Admin keep it.";
