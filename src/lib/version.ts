// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-106";
export const RELEASE_NOTE =
  "-106: the portal ships the hours column in TWO shapes and we only read one. Found by smoking "
  "the new qualification column against REAL production imports instead of fixtures: the live "
  "Attendance Report 06-08-2026 on Bhadohi SPIT-01 carries hours as decimals (26.6, 73.99, "
  "109.94), not hh:mm:ss, so all 28 matched rows stored null minutes and the whole batch read "
  "no hours - nobody on a live batch could be judged qualified, including students well past the "
  "60-hour bar. Decimal hours are read now, in the one function the whole app converts this "
  "figure with, and deliberately strictly: anything that is not a duration or a plain number "
  "still returns null rather than becoming a silent hour count. The same file is also missing a "
  "days-present column we recognise, so the importer now REPORTS which expected columns a file "
  "does not carry, and warns before committing when no row produced an hour figure at all - a "
  "blank column is explained instead of looking like missing data. "
  "-105: two more places the batch status was still printing the raw enum, both found in the "
  "browser rather than by grep: the green running banner on a batch Overview said 'Closing' two "
  "lines under a header chip that said 'Result Awaited', and the batches-list search index only "
  "matched the enum, so typing what the screen shows found nothing. The banner uses the same "
  "label map now, and the list is searchable by BOTH words - the client types 'Result Awaited', "
  "an engineer reading an audit row types 'Closing'. "
  "-104: found by driving the -102 resolve drawer in a real browser, not by reading code. Two "
  "same-name candidates carrying no portal ID rendered as two IDENTICAL option rows, so the one "
  "screen whose entire job is 'pick the right one' gave the operator nothing to pick on - the "
  "exact case it was built for (Manish's two Sachins). Each option now carries the phone, which "
  "is unique per candidate, plus the enrolment date and enrollment status, which is how a centre "
  "register is actually ordered. "
  "-103: a candidate can be UN-MARKED. Found by running the -102 cleanup on production: the new " +
  "member-removal door correctly refused two test roster rows because each carried a Pass result, " +
  "and nothing could remove a CandidateResult - only PATCH it to another value. A row created on " +
  "the wrong candidate was permanent, and because `legacy` is decided by 'zero result rows', one " +
  "accidental row flipped a batch to per-candidate marking forever and its closure figures then " +
  "derived from it. DELETE /api/results/<id> un-marks: reason required, refused on a Completed or " +
  "Cancelled batch (DEC-6), refused once assessment or certification has been signed off, refused " +
  "while a certificate file is attached (remove that first, so no object is orphaned), and audited " +
  "with the whole row including the attempt count. With the last row gone the batch returns to " +
  "batch-level figures, and the -102 member door finally lets go. " +
  "-102: the six things that got in Manish's way during the 17/08 walkthrough. A trainer had to " +
  "hunt four clicks for the one thing they sign in to do, so Home now opens with 'log your " +
  "today's candidate attendance' per running batch (and the portal-import door for Admin/Ops) - " +
  "Rule 33's queue could not serve this because it reports the PREVIOUS day. Daily Execution used " +
  "to open blank on a day that was already logged, so adding a second photo at 2pm meant " +
  "re-ticking all 45 students: it now reads the day it points at, arrives pre-checked, and Save " +
  "updates that day through the same audited Rule 27 door while media APPENDS. The bulk grid no " +
  "longer opens onto a dead range - it starts at the earliest unlogged day, says how many are " +
  "open, and names the reason each date was left out instead of a bare 'no open days in this " +
  "range'. The batches list leads with Status on every screen size and shows the readiness chip " +
  "only while a batch is still being prepared, so a running batch stops crying Red over logs " +
  "nobody has entered yet. The government-attendance grid regained the QUALIFICATION column - " +
  "Qualified at or above the hours bar, Not eligible below it, and honestly unanswered when the " +
  "portal sent no hours - reusing the batch tab's own bar and verdict so the two screens cannot " +
  "disagree. And an Ambiguous row is finally a door rather than a dead end: it opens onto the " +
  "portal row as received, the importer's reason for not guessing, and the candidates that " +
  "collided, so the operator can record the answer they already have as an audited manual match. " +
  "With them: a roster row enrolled by mistake can be removed (Admin only, reason required, " +
  "refused outright once it carries a result, attendance or a matched portal row), which also " +
  "puts the candidate back in the planner's pool; and 'Closing' is worded 'Result Awaited' " +
  "everywhere while the stored enum stays 'Closing'.";
