// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-9";
export const RELEASE_NOTE =
  "CEO round-2, Cycle A — attendance for the trainers' Monday go-live: daily attendance is " +
  "now marked in timestamped ROUNDS (P-P-P as many times a day as needed; each round unions " +
  "into the day), every student carries a per-day BIOMETRIC tick with Rule 51 enforced " +
  "('biometric done & not present cannot happen'), and a trainer-role login can mark only " +
  "their own batch. Locations grid: the sheet's Already-Enrolled/Pending-Enrollment claim " +
  "columns are gone (enrolment is ours to count) and Operational starts hidden.";
