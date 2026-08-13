// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-4";
export const RELEASE_NOTE =
  "Candidate buckets (CEO): the Candidates page is now TWO buckets — Fresh (inquiry " +
  "se batch-assign tak) and Enrolled (batch se aage ki poori journey). The Enrolled " +
  "bucket speaks the CEO's terminology — Enrollment in progress → Training Ongoing → " +
  "Training Completed → Result Awaited → Certified / Not Certified — derived live from " +
  "the batch and results, never stored. Pills, counts and the status column follow the " +
  "active bucket; deep links pick their bucket automatically.";
