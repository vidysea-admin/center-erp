// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-42";
export const RELEASE_NOTE =
  "R-J: money on the candidate, and batch codes that speak the CEO's format. " +
  "Candidates carry fee_amount / fee_paid_on / fee_reference; a paid fee shows " +
  "as the 'Fee Paid' stage in the Fresh journey, and Rule 54 - enrollment " +
  "cannot complete without a fee on record - is a Defaults toggle, OFF by " +
  "default because government-funded schemes charge nothing. Batch codes are " +
  "now CENTRE-COURSE-NN (AVP-GURU-DST-01), numbered per centre x course - " +
  "shipped BEFORE the bulk batch-planning wave so 8-10k batches are not " +
  "minted in the old global B-serial format.";
