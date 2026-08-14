// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-56";
export const RELEASE_NOTE =
  "QA-069 + QA-011 (both S1). The Enrolled journey now tells the truth: " +
  "a candidate whose assessment is RECORDED shows Certified / Failed / " +
  "Absent at Assessment from the result itself (latest_result rides on " +
  "every row) - no more 'Result Awaited' for people the register says " +
  "were certified, because the journey no longer waits on a " +
  "lifecycle_status that historical imports never wrote back. And the " +
  "Active Trainers KPI stops lying to scoped users: a centre's SPOC " +
  "receives their own centre's scope-aware trainer count (the same " +
  "nomination/capability/home/batch union their trainers page uses), " +
  "the card renders on key presence, and the central unscoped " +
  "Enrollment login still gets no organisation-wide figure.";
