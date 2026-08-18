// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-113";
export const RELEASE_NOTE =
  "-113: the Admin can finish a batch. Umesh, 18/08, after -112 shipped: 'admin ke paas mark "
  "completed ka button aaye, aur wo press kar paye - jaise abhi wala press bhi nahi ho raha na.' "
  "He is right, and -112 could not have fixed it: the buttons refuse until the ROWS allow it - "
  "Rule 43 wants every student marked, Rule 46 wants every pass settled - and on DST-01 that is "
  "26 students nobody marked and one pass with no certificate. Real missing facts, and the rules "
  "are right to hold. But a batch that ended on site months ago has to be closable. So the Admin "
  "gets the door this codebase already uses for exactly this problem (Rule 19: force-close by an "
  "Admin, with a reason): it writes the HONEST default for each outstanding row - no result means "
  "ABSENT, a pass with no certificate means NOT ISSUED - every row audited by name under one "
  "typed reason, and only then completes. No rule is weakened and no figure is invented; the "
  "screen lists exactly what it will settle, with the names, BEFORE it is pressed. Because one "
  "press can now finish a batch, one press can also put it back: an Admin REOPEN door "
  "(Completed to Result Awaited, reason required, audited) that also clears the end date, so "
  "attendance is not refused for days after an end that no longer applies. DEC-6 is not "
  "weakened - the freeze still holds against everyone and everything else; it is now liftable by "
  "the one role that could always force a close. Also fixed, found by measuring live DST-01 "
  "minutes after -112 deployed: the closure summarised the rows BEFORE settling them, so eight "
  "certificates read Issued while the closure still said 'certificates issued: 0 derived' - the "
  "settle now runs first. On DST-01, -112 already took the certification blocking list from 9 to "
  "1. "
  "-112: the batch that would not complete, and the trainer link -111 dropped. TWO THINGS. (1) A "
  "REGRESSION I shipped in -111: the Log-today attendance strip on Home was nested inside an "
  "Admin-only block, so the TRAINER - the person it exists for - had no path to today's log at "
  "all. The strip now stands on its own; a new wall suite (check-home-structure) pins its "
  "position, and it fails on the -111 file, which is what the -111 wall could not do because the "
  "old pin asserted API JSON rather than the rendered page. (2) QA-219 / Manish 17/08 (M4-01, "
  "M4-03, M4-07, VM-01, VM-02): AVP-GURU-RPLAVP-DST-01 carried 9 passes and 8 certificate files "
  "and still read Active with Mark Completed doing nothing. Nothing was broken - attaching a "
  "FILE never advanced Rule 46's status ladder, and the two closure halves plus the batch "
  "transition were three separate hand presses that each refused until the one before it was "
  "ticked. Now the file IS the certificate (a Pending row with a file settles to Issued, "
  "including rows attached before this release), every roster row final derives assessment "
  "Completed, and every pass settled derives certification Completed. Derivation states FACTS "
  "about the rows and never moves the batch: the batch ladder is one-way (no Closing to Active) "
  "and Completed is the DEC-6 freeze with no admin override, so a derived transition could not "
  "be walked back the way a derived sign-off can - un-mark a student and the sign-off returns to "
  "Pending by itself. Both buttons stay human and now succeed on the FIRST click instead of "
  "bouncing off Rule 18, and the Complete button says it will freeze the figures. A human tick "
  "still owns the status from then on, and a human sign-off still blocks un-marking - only the "
  "derived one does not, because nothing was reported. Three guards came out of the wall rather "
  "than review: a REJECTED certificate is never revived by the settle (Pending only); removing a "
  "file that was the only evidence puts the row back to Pending so the result can still be "
  "corrected; and with a certificate attached the result can no longer be flipped out from "
  "under it (Rule 45 always said so - it just never fired while the status stayed Pending). "
  "The readiness checklist collapses once a batch is running (M4-07). "
  "-111: what the user actually sees - five things Umesh named on 18/08 after using the ERP, all "
  "measured on production in a real browser before a line changed. (1) 'Rule this, rule that - "
  "aisa koi rule hai nahi.' Our ledger names (Rule 45, DEC-6, QA-142) were on 28 screen strings "
  "and 52 API refusals. They are gone from every screen: plain() in lib/user-copy strips them at "
  "the two chokepoints (apiHandler for every server error, ErrorBanner for the client), the source "
  "strings were rewritten to what-happened-plus-what-to-do, and a static wall check "
  "(scripts/check-user-copy.mjs) plus a passive scan of every 4xx the wall sees keep it that way. "
  "The rules themselves are untouched; only the words. (2) Text-heavy: the Closure two-job banner "
  "is one line with a ?, the attendance note rides on the bar chip, the certificate hint is eight "
  "words. (3) The Home page had my own -102 Today section ABOVE the KPI cards, pushing them below "
  "the fold, and nothing below had a height cap (2,041px, three screens). Cards are first again; "
  "Today is a compact strip under them; every queue is a five-row box with its own scroll and a "
  "View all link (Section maxRows, one place). (4) Sync: the watch cadence goes to once a day; a "
  "REAL bug fixed - all three SheetChange/WorkbookChange creation sites deduped against OPEN rows "
  "only, so a change the user had Ignored or Actioned was recreated by the next tick (the "
  "'acknowledge kiya, wapas aa gaya'); a decision already taken now suppresses re-creation. The 37 "
  "Open rows from the 14/08 first-sync are archived (Ignored, with a note), not deleted; the Sheet "
  "Sync tabs each show their own open count so a stale pile can never hide behind the badge total. "
  "(5) The certificate-upload report stayed on screen forever; there was no notice component at "
  "all. Notice: cross always, success/info leave by themselves in 15s (progress bar, hover pauses), "
  "errors never auto-hide. Used for the certificate report (refused lines stay) and portal-ID link. "
  "-110: SMS. EnableX carries SMS (and later WhatsApp); email stays on SES - Umesh's scope. The "
  "portal was explored end to end before a line was written: the credential in the repo's parent "
  "was a portal LOGIN, not an API key; the account holds SMS project VIDYSEA_SMS_ENABLE_X, sender "
  "VIDYSE (fulfilled), an ACTIVE campaign, and exactly ONE approved DLT template - the OTP one, "
  "888579131 - whose wording differs from the OTP screenshot in circulation, so building to that "
  "screenshot would have been rejected by the gateway on every send. lib/sms.ts is the twin of "
  "lib/mailer.ts: env-only credentials from the app's own directory, never throws, every outcome "
  "lands in the ONE MailLog with channel sms, and suppression is STRUCTURAL first (a non-production "
  "DB or localhost auth means off, flag or no flag) with SMS_DISABLED as the MAIL_DISABLED twin - "
  "so no wall run can text one of 167 real students. The template is data, rendered by "
  "substitution into the approved text; a purpose with no configured template ID records skipped "
  "and sends nothing, so QA-189/190's messages ship switched off until each is approved on DLT. "
  "The public enrolment form gains a mobile-number path: the same hardened 6-digit challenge over "
  "SMS, with three gates the email flow never needed because a code now costs money - a per-phone "
  "cap independent of IP, a resend cooldown, and a global daily cap that raises a Notification to "
  "Admin/Ops rather than stopping quietly. The verified number becomes the phone of record, exactly "
  "as the verified address does on the email path. The first real SMS is a person's decision, not "
  "a build step. "
  "-109: two things Umesh caught. (1) 'Not eligible' was being said about students it was not "
  "true of. Measured on production: BHA-SPIT-02 read it for all 31 students THREE DAYS into a "
  "fifteen-day course; BHA-SPIT-01 for all 45 purely because that file's decimal hours never "
  "parsed; CHI-DST-03 for all 45 with no import at all; on DST-01, 20 of 29 simply were not in the "
  "import. A missing-data state and an unfinished course were both rendering as a negative verdict "
  "about a real student, on the screen where certificates get decided. His answer shaped the fix: "
  "the verdict belongs to the candidate JOURNEY - documents, registration, portal registration, "
  "batch assigned, enrolled - so a student who has not finished enrolling gets no verdict at all. "
  "One shared eligibilityVerdict now decides, with two gates: the journey gate, and a time gate - "
  "below the bar while the course RUNS is progress ('42 of 60 hrs so far'), no imported hours is "
  "'no portal hours yet', and 'Not eligible' waits until the course is actually over. The batch "
  "Attendance tab, the Closure cards and the portal import grid all read that one function, and "
  "each screen now reports the split - qualified / still short / no hours / not eligible - instead "
  "of one lumped bucket. `qualified` keeps its old meaning so nothing else moved. "
  "(2) A student registered from INSIDE the ERP got no mail. There were nine send sites and none "
  "of them was POST /api/candidates - every registration mail lived on the public self-registration "
  "paths, so the moment was simply never built; SES was live and sending all along. It sends now, "
  "fire-and-forget so registration never fails on mail, and a phone-only student is recorded as a "
  "skip WITH its reason rather than silently nothing - 'mail gaya ki nahi' is answerable per "
  "candidate either way. The SMS fallback Umesh asked for needs a provider and its credentials, so "
  "it is raised for him rather than half-built. "
  "-108: certificate upload. The reason none of Manish's eight files would attach was not the "
  "files - every one was named correctly - but that NOT ONE of the 39 roster candidates carried a "
  "portal ID, and that field is the only key the matcher joins on. So the lookup was empty, every "
  "file had to fail, and the screen blamed the file. The mapping was never missing either: the "
  "portal import had already matched all 24 rows to those candidates BY NAME and stored each CAN "
  "id - the importer just never wrote it back. It does now, on unambiguous matches only and never "
  "over an existing id, plus a one-click Link portal IDs for everything imported before, so "
  "nobody re-uploads a file they already imported. Bulk upload is preview-first: every file is "
  "listed with the candidate it is going to and any of them can be changed BEFORE anything is "
  "written, which is what makes a wrong auto-match fixable instead of silently committed; "
  "unmapped files are discarded, an abandoned preview is cleaned up by the next one, and a url "
  "this batch never staged cannot be attached. Each candidate card also takes a certificate "
  "directly - no file name, no ID. And the screen now says everything up front: how many of the "
  "roster carry a portal ID, who can take a certificate today and who cannot in plain words, this "
  "batch's own expected file names to copy, and when a file cannot be matched it says the roster "
  "has no IDs rather than blaming the file. Rule 45 still stands, shown in the preview and "
  "enforced on the write, with a Mark Pass button beside it. "
  "-107: the trainer dashboard gets the government-sheet upload - and the reason it was missing "
  "was a DEAD TOGGLE, not an absent feature. The importer API has always gated on the "
  "attendance.govt right, but every screen gated on the ROLE, so granting a trainer that right "
  "changed nothing anywhere: Anuj Kumar carries it on production and never saw a door. All four "
  "gates now read the right - the sidebar, the batch Attendance tab, the Daily Execution history "
  "and the Home Today row - and Trainer joins the route ceiling so the grant can actually reach a "
  "screen. It stays OFF for the Trainer role by default, so the trainers who only mark daily logs "
  "see nothing new; a trainer Umesh grants it to gets the upload on their own dashboard. Pinned "
  "both ways: without the right the API refuses (403), with it the importer opens, and revoking "
  "closes it again. "
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
