// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
// KEEP THIS FILE ASCII. -117 first shipped its note with three Devanagari lines quoting Manish;
// tsc was happy, the Turbopack build was not ("failed to analyze ecmascript module" -> every route
// importing @/lib/version could not resolve), and the wall then ran against a stale .next. Romanise
// quotes here; the Devanagari belongs in the ledger and the manifests, which are read, not compiled.
export const RELEASE = "2026.08.14-127";
// -127 (QA-181): this file used to be ONE constant whose continuation lines carried no `+`.
// JS then applied automatic semicolon insertion: the first line became RELEASE_NOTE and the other
// 329 became dead no-op expression statements. Production published a 97-character note for an
// unknown number of releases. Joining them made the constant whole (32,613 chars) - and made the
// UNAUTHENTICATED /api/public/version endpoint publish the entire internal archive, which is worse
// than the truncation was. So the note is two constants: what THIS build changed, which is what a
// public build-marker is for, and the archive behind it, which stays in the bundle for anyone with
// the source. Bumping a release writes RELEASE_NOTE_CURRENT and moves the old text to the archive.
export const RELEASE_NOTE_CURRENT =
  "-127 (QA-180): a TRAINER is not a candidate for assessment. Every government attendance export " +
  "carries the centre's own trainers alongside its students - the live Attendance_Till 16th Aug " +
  "file is 37 Trainee rows and one Trainer, Manish himself at 53:48:25 hrs - and the qualification " +
  "grid handed every one of them a student verdict. His own row read 'Not eligible' on -106 and " +
  "'Not enrolled yet' after -109. Both are category errors, and the first matters most because " +
  "'not eligible' is exactly the filter used to build the list of students to chase: it handed him " +
  "his own trainer. -109 had already written the right answer, but behind a no-bar branch - and the " +
  "importer stamps the import's batch onto EVERY row including trainers', so a batch-scoped upload " +
  "(how a centre actually uploads) always supplied a bar and always skipped it. That branch was " +
  "dead code for the entire real-world path. The gate now runs FIRST and reads the EXPORT's own " +
  "type column rather than whether the ERP happened to match a trainer record, so a trainer the ERP " +
  "has never heard of is still not assessed. Trainers get their own count, so the buckets still add " +
  "up to the row count and the strip stops overstating how many students need chasing. Measured " +
  "before it was written: the old fixture committed an import with NO batch, so it never reproduced " +
  "the bug at all - the pin had to be moved onto the production shape first. QA-181, found while " +
  "writing this very note: see the comment above - the note itself was truncated to one line.";

// The archive. Everything this product has shipped, newest first.
const RELEASE_NOTE_ARCHIVE =
  "-126: Shivshakti's 18 Aug round, and it is not about the fields being wrong - he says twice that " +
  "they are right. S18-01: the government block shipped in -116 as a COLLAPSED section, so filling a " +
  "candidate took two passes; it is inline now, same fields, same grid, no lid. S18-03: 'ye dono " +
  "option hata do' - Address type and Differently abled are gone from the form and from BOTH " +
  "candidate route whitelists. Worth remembering why they existed: he named EIGHT fields out loud " +
  "and I read three more off the portal screenshot and added them; his spoken request stands, my " +
  "inference did not. The model columns stay - measured first, 0 of 206 candidates carry any portal " +
  "field, and dropping a column is the one change that cannot be undone. S18-02: the self-registration " +
  "link form never got any of this. SS-01 landed on the internal form and the two internal routes and " +
  "never touched the public page, so a candidate who self-registered still had to be chased for " +
  "exactly the data those fields exist to stop chasing. All nine are on it now, all optional - the " +
  "person filling it is a student on a phone from a WhatsApp link, and a long required form is a form " +
  "they abandon. S18-04 turned out to be the SAME fix: that page was the one intake path still " +
  "validating with native `required`, which is why a missed Program produced the browser's own bubble " +
  "in the browser's words. It now uses lib/validate like every other path and says what is missing " +
  "itself - which also ended a real divergence, since the route behind it re-implemented phone " +
  "validation as length >= 10 while the rest of the product used canonicalPhone. " +
  "-125: VM-03, and the measurement changed what the fix should be. The video pass flagged the " +
  "trainers HOME LOCATION column as inconsistent - full centre records beside bare town names like " +
  "Banda and Basti - and the row asked for a data audit. Measured on live first: 22 trainers, 4 " +
  "linked to a real centre, 18 carrying free text - and those 18 are DISTRICTS (Ballia, Ghazipur, " +
  "Basti, Azamgarh, Begusarai...), sixteen of which name places where we have NO centre at all. That " +
  "is not dirty data. It is home_location_other doing exactly the job it exists for, and the column " +
  "was rendering two different KINDS of fact identically, which is what made it look wrong. So the " +
  "column now names the kind: a linked centre reads plainly, a district reads in muted text with " +
  "'no centre here' beside it and an explanation on hover. No data is rewritten - auditing honest " +
  "data into a shape it does not have is how real information gets destroyed. Two of the eighteen DO " +
  "name a place where a centre exists, and those are now visibly the odd ones out, which is the only " +
  "part a human should act on. " +
  "-124: M4-04, the last buildable row on Umesh's sheet. Manish: 'ye location nahi hogi, user ka koi " +
  "bhi location ho sakta hai - yahan pe ye location mat dikhao.' Forcing a centre when a walk-in is " +
  "entered either invents a fact or turns the person away. I had been calling this its own unit " +
  "because it touches Rule 38 scoping, and it does - so the centre is not removed, it is DECIDED BY " +
  "THE FIRST REAL EVENT. There was already a precedent one line away: a programme-less candidate " +
  "adopts the batch's programme when enrolled. A location-less one now adopts its centre the same " +
  "way, audited by name because that is the moment the record becomes visible to that centre's " +
  "staff. Three things deliberately unchanged: a candidate who belongs to ANOTHER centre is still " +
  "refused (Manish's own rule from 13/08); a SCOPED user must still name their own centre, because " +
  "QA-125's reasoning holds - they would otherwise create a person their own list can never show " +
  "them; and unplaced candidates are invisible to scoped users until adoption, which is what " +
  "belonging to no centre means. The form keeps the field, since most entries do know the centre, " +
  "but the blank option now reads 'Not tied to a centre yet (walk-in)' rather than looking like an " +
  "unfinished form. " +
  "-123: QA-157, the half that was still real. Two of the three bypasses that row named are already " +
  "gone - HEIC converts in the browser since -87, and uploadClosureFile went through the shared " +
  "helper - so I swept every upload path instead of assuming: the only one still posting whole files " +
  "was the BULK certificate upload, which is the one Manish actually uses. It built its own FormData " +
  "and sent the files untouched, while the single-candidate path beside it has compressed since day " +
  "one. A scanned certificate is exactly the large image compression exists for, and the storage " +
  "arithmetic on QA-104/QA-145 assumes about 2 MB a photo. It compresses now, still BEST-EFFORT - " +
  "compressImage returns the original on any decode failure, because an upload must not fail - and " +
  "the result is REPORTED rather than silent, which was the other half of the complaint. The file " +
  "NAME is load-bearing and is preserved exactly: the -108 matcher reads CAN_12345 out of it, so a " +
  "compressed blob is re-wrapped under the same name and a changed extension can never break the " +
  "matching the preview depends on. " +
  "-122: QA-093 - the number that decides who may sit an assessment is two assumptions stacked on " +
  "each other, and only one screen ever said so. Measured on live: NONE of the five programmes " +
  "carries QP hours. So DST-01's bar of 60 hours is built as duration_days 15 x 8 hours a day = 120, " +
  "then x 50 percent from Defaults. Neither number came from the scheme. The govt-attendance screen " +
  "has disclosed this since -102 to the person READING a verdict; what was missing was telling the " +
  "person who can FIX it, on the screen where the field lives. Admin > Programs now carries a QP " +
  "hours column that reads 'not set -> assuming Nh' in amber with the full derivation on hover, and " +
  "the note under the input says which of the two states you are in. NO HOURS ARE INVENTED - " +
  "inventing them is precisely the failure this row is about; the fix is to make the assumption " +
  "visible to the one person who can replace it with the scheme's real figure. Caught while writing " +
  "it: my first attempt put that sentence inside a JSX COMMENT, where no user would ever see it - " +
  "the static copy check passes comments, so nothing would have failed. " +
  "-121: QA-260. The checker FAILED -119 for the right reason: its release note claimed a behaviour " +
  "the code did not have. The note said a trainer with no email would be recorded in MailLog as " +
  "'skipped: no valid recipient address', so 'did it go?' stays answerable per trainer. On live it " +
  "recorded nothing at all - the path returned early before any log. That is QA-250 one screen over: " +
  "-109 found MailLog.to is required, so an empty address threw inside a swallowed catch, and the " +
  "one case where the answer was not recorded was the case where the mail certainly had not gone. " +
  "The fix was described then as covering all nine send sites; the trainer path added in -119 was " +
  "the tenth and did not carry it. THE CLAIM WAS THE RIGHT BEHAVIOUR, so the code moved rather than " +
  "the note: sendMail is now called either way and records the skip itself. My own wall pin passed " +
  "for the wrong reason - it accepted 'no row at all' as success and could never have caught this - " +
  "so it now REQUIRES the row and requires it to name the missing address. The checker also warned " +
  "that /api/test-email caps its log at 20 rows, so any count-based check can never move; the pin " +
  "reads rows, not counts. " +
  "-120: M4-14, the chain Manish did not just describe but TYPED on screen - the data half of it. " +
  "His list: mock test / formulation test date, who all are APPEARING, who all are QUALIFYING, a " +
  "provision for the assessment date, a tentative result date, how many passed and failed, the " +
  "reason for a fail, a certificate distribution date, the certificate number, upload to the SIDH " +
  "portal, and raise the invoice for all passed - plus the roll number near the top. Read it and " +
  "almost every noun is a DATE or a LIST; the only thing still owed is his mock-test STATUS wording. " +
  "So the dates and the lists are built and NO status enum is invented: mock test date, result " +
  "expected (tentative), certificate distribution date and uploaded-to-SIDH date on the closure; " +
  "appeared and qualified as TWO separate per-candidate facts rather than one flag, because the gap " +
  "between them is exactly what a centre acts on before the real assessment; a note carrying WHY " +
  "someone did not qualify, which is M4-17 applied to the mock test; and the roll number per " +
  "candidate, distinct from the certificate number and from the portal id. Everything is optional " +
  "and gates nothing - a batch that never ran a mock test is untouched - and the wall pins both that " +
  "the fields survive a round trip (the -116 lesson: a field a route does not accept looks saved and " +
  "is gone on the next read) and that marking the real result does not wipe them. Already existing " +
  "and deliberately not rebuilt: the assessment date, pass/fail counts, the fail reason (Rule 44), " +
  "the certificate number (Rule 46), the file, and the invoice ladder (Rule 36). " +
  "-119: two of Manish's rows that were sitting done-in-diagnosis and not-done-in-code. M4-15, the " +
  "assessor name: I established on 18/08 that NO rule requires it - it never blocked closure, the " +
  "confusion was a bare 'Assessor name' placeholder reading as mandatory - then wrote 'rides the " +
  "next release' and let four releases go past without the two words. It now reads 'Assessor name " +
  "(optional)' and says on hover that the assessment body appoints the assessor, so a centre often " +
  "never learns the name and closure proceeds regardless. M4-16, Add Trainer: the candidate welcome " +
  "mail shipped in -109 after Umesh found nine mail paths existed and none was the one an admin " +
  "actually uses; Manish asked for the same on the trainer screen and it is a separate screen with a " +
  "separate mailer, which is why the sheet calls it separate work. Same discipline as the candidate " +
  "path: fire-and-forget so creating a trainer never fails on mail, and a trainer with no email is " +
  "not an error - MailLog records 'skipped: no valid recipient address' rather than pretending. No " +
  "SMS arm: that needs its own approved DLT template, and inventing one would be a send that cannot " +
  "happen. Pinned on the MailLog row, because that is the only thing that answers 'did it go?' " +
  "months later. " +
  "-118: the measurement that corrected -117. -117 pre-assigned the room when a centre had exactly " +
  "one; then I measured production and of 21 centres ZERO have exactly one room and EIGHTEEN have " +
  "none at all - so that rule fires for nobody today. Manish's complaint was mostly not about " +
  "nothing being pre-selected: for most centres the dropdown is EMPTY, which is the same thing " +
  "QA-147 found on the batch page (CHI-ITI simply had no rooms). An empty dropdown that reads " +
  "'- assign later -' looks like a choice is being offered. It is not. The New Batch form now says " +
  "the centre has no rooms, disables the control, explains that readiness cannot pass without one, " +
  "and links to the centre's Trainers and Infra tab where a room takes a name and a type - the same " +
  "way out the batch page has offered since QA-147, which the form it starts from had never caught " +
  "up with. With several rooms it says how many and warns that two batches in one room on the same " +
  "days is refused on save. The -117 pre-assignment stays: it is right the day a centre has one room. " +
  "-117: M4-09, the last buildable half of Manish's New Batch complaints. 'yahan pe kuch aata nahi hai, " +
  "abhi bhi assign nahi karta hoon - to maan ke chalo room one hi hoga': the room dropdown was populated and " +
  "nothing was ever chosen, so every batch was created with no room and the readiness check then " +
  "failed on a room that was sitting right there. When the centre has exactly ONE room that suits " +
  "the programme it is now taken automatically and stays editable; with SEVERAL it deliberately " +
  "stays unchosen, because guessing between real rooms is how two batches quietly land in the same " +
  "room on the same days (Rule 13). And 'target size default 45 leke chalo': the number belongs to the " +
  "PROGRAMME - a 45-seat course and a 30-seat course both exist - so the form still reads it from " +
  "there; what changed is the fallback and the new-programme default, both 45 now, plus a line " +
  "under the field naming the programme's own figure when it differs. Programmes already storing 30 " +
  "keep 30 until someone edits them: silently rewriting five live programmes is a data decision, " +
  "not a UI change. " +
  "-116: the button where the press actually happens, and four sheet rows I had been treating as " +
  "blocked. Umesh, 18/08: 'manish sir mark complete karenge but complete button show hona chahiye " +
  "right, and andar wala complete button kaam nahi kar raha na.' Both halves were true. Manish IS " +
  "an Admin, so -113's door was visible to him - but it sits on the OVERVIEW tab, while the button " +
  "he presses is inside the CLOSURE tab, and that one refused with an error banner far above where " +
  "he was looking. From his seat it did nothing at all. So: the two Closure buttons now know their " +
  "own rule instead of bouncing off it (disabled, naming the count and who is blocking them - the " +
  "pattern QA-004 established), and the Admin door is offered ON THAT TAB, only when the ordinary " +
  "buttons cannot fire. Then four rows from Umesh's issue sheet I had been holding for " +
  "confirmation, built to exactly what the sheet itself states: M4-06 Source becomes a list " +
  "(Mobiliser, Campaign, Referral, Franchisee, Walk-in, Government portal) that still accepts " +
  "anything typed, because the sheet flags the wording as unreliable and a closed enum would freeze " +
  "a guess into the data model; M4-10 time slots get preset buttons that FILL the inputs and leave " +
  "them editable ('time slot hum change kar sakte hain'), offering only the three slots the sheet " +
  "marks reliable; SS-01 adds all eleven government-portal fields Shivshakti showed - the eight he " +
  "named plus the three the video pass read off the portal screen - optional, collapsed, and pinned " +
  "to store and read back. The portal's Education and Employment section was never opened on " +
  "screen, so its fields stay unknown rather than invented. " +
  "-115: three the checker's sweep raised, none of them glamorous. QA-218: /api/public/version has " +
  "been reporting evidence_storage 'drive' on every deploy while production actually runs on GCS " +
  "via Workload Identity Federation - the label was hardcoded to 'configured at all'. That endpoint " +
  "exists to be trusted from outside, so it now names the real backend. QA-223 (Manish M4-08, 'ye " +
  "trainer required - aise click kara to yahan pe koi field hai hi nahi'): the Locations table's " +
  "TRAINER REQUIRED cell landed on a generic Overview with nothing to type into. The field always " +
  "existed on the centre's Capacity and Target tab - but the tab lived in local state, so nothing " +
  "could link INTO it. ?tab= now works on the location page and the cell opens the right tab, " +
  "reading 'set' when the number has never been entered. QA-239, and this is the interesting one: " +
  "the checker probed plain() directly and found three edges - a bare 'DEC-6' or 'QA-142' " +
  "mid-sentence passed through untouched, a bare 'Rule 27' mid-sentence left a hole in the " +
  "sentence, and the R-alternative ate legitimate parentheticals ('Room (R-4)' became 'Room'). Two " +
  "are fixed in the function. The third is fixed in the GUARD instead: no regex is going to repair " +
  "English, so check-user-copy.mjs stopped skipping thrown messages and now fails the wall unless " +
  "the code sits in a shape plain() strips cleanly - leading, bracketed or trailing. Proved by " +
  "planting both bad shapes and watching the suite go red. All 61 existing messages already " +
  "comply. " +
  "-114: QA-238, raised by the checker against LIVE -112 and worth saying plainly: every one of " +
  "DST-01's eight Issued certificates carries NO certificate NUMBER, and the screen said '8 already " +
  "have one' with nothing hinting that not one of them can be invoiced against. The file settles the " +
  "candidate's STATUS; the number is what invoicing and audits quote, and it arrives later from the " +
  "awarding body. So the count of Issued-without-a-number now sits beside the count of Issued, with " +
  "the sentence explaining where to add it. One derived figure, no rule touched. " +
  "-113: the Admin can finish a batch. Umesh, 18/08, after -112 shipped: 'admin ke paas mark " +
  "completed ka button aaye, aur wo press kar paye - jaise abhi wala press bhi nahi ho raha na.' " +
  "He is right, and -112 could not have fixed it: the buttons refuse until the ROWS allow it - " +
  "Rule 43 wants every student marked, Rule 46 wants every pass settled - and on DST-01 that is " +
  "26 students nobody marked and one pass with no certificate. Real missing facts, and the rules " +
  "are right to hold. But a batch that ended on site months ago has to be closable. So the Admin " +
  "gets the door this codebase already uses for exactly this problem (Rule 19: force-close by an " +
  "Admin, with a reason): it writes the HONEST default for each outstanding row - no result means " +
  "ABSENT, a pass with no certificate means NOT ISSUED - every row audited by name under one " +
  "typed reason, and only then completes. No rule is weakened and no figure is invented; the " +
  "screen lists exactly what it will settle, with the names, BEFORE it is pressed. Because one " +
  "press can now finish a batch, one press can also put it back: an Admin REOPEN door " +
  "(Completed to Result Awaited, reason required, audited) that also clears the end date, so " +
  "attendance is not refused for days after an end that no longer applies. DEC-6 is not " +
  "weakened - the freeze still holds against everyone and everything else; it is now liftable by " +
  "the one role that could always force a close. Also fixed, found by measuring live DST-01 " +
  "minutes after -112 deployed: the closure summarised the rows BEFORE settling them, so eight " +
  "certificates read Issued while the closure still said 'certificates issued: 0 derived' - the " +
  "settle now runs first. On DST-01, -112 already took the certification blocking list from 9 to " +
  "1. " +
  "-112: the batch that would not complete, and the trainer link -111 dropped. TWO THINGS. (1) A " +
  "REGRESSION I shipped in -111: the Log-today attendance strip on Home was nested inside an " +
  "Admin-only block, so the TRAINER - the person it exists for - had no path to today's log at " +
  "all. The strip now stands on its own; a new wall suite (check-home-structure) pins its " +
  "position, and it fails on the -111 file, which is what the -111 wall could not do because the " +
  "old pin asserted API JSON rather than the rendered page. (2) QA-219 / Manish 17/08 (M4-01, " +
  "M4-03, M4-07, VM-01, VM-02): AVP-GURU-RPLAVP-DST-01 carried 9 passes and 8 certificate files " +
  "and still read Active with Mark Completed doing nothing. Nothing was broken - attaching a " +
  "FILE never advanced Rule 46's status ladder, and the two closure halves plus the batch " +
  "transition were three separate hand presses that each refused until the one before it was " +
  "ticked. Now the file IS the certificate (a Pending row with a file settles to Issued, " +
  "including rows attached before this release), every roster row final derives assessment " +
  "Completed, and every pass settled derives certification Completed. Derivation states FACTS " +
  "about the rows and never moves the batch: the batch ladder is one-way (no Closing to Active) " +
  "and Completed is the DEC-6 freeze with no admin override, so a derived transition could not " +
  "be walked back the way a derived sign-off can - un-mark a student and the sign-off returns to " +
  "Pending by itself. Both buttons stay human and now succeed on the FIRST click instead of " +
  "bouncing off Rule 18, and the Complete button says it will freeze the figures. A human tick " +
  "still owns the status from then on, and a human sign-off still blocks un-marking - only the " +
  "derived one does not, because nothing was reported. Three guards came out of the wall rather " +
  "than review: a REJECTED certificate is never revived by the settle (Pending only); removing a " +
  "file that was the only evidence puts the row back to Pending so the result can still be " +
  "corrected; and with a certificate attached the result can no longer be flipped out from " +
  "under it (Rule 45 always said so - it just never fired while the status stayed Pending). " +
  "The readiness checklist collapses once a batch is running (M4-07). " +
  "-111: what the user actually sees - five things Umesh named on 18/08 after using the ERP, all " +
  "measured on production in a real browser before a line changed. (1) 'Rule this, rule that - " +
  "aisa koi rule hai nahi.' Our ledger names (Rule 45, DEC-6, QA-142) were on 28 screen strings " +
  "and 52 API refusals. They are gone from every screen: plain() in lib/user-copy strips them at " +
  "the two chokepoints (apiHandler for every server error, ErrorBanner for the client), the source " +
  "strings were rewritten to what-happened-plus-what-to-do, and a static wall check " +
  "(scripts/check-user-copy.mjs) plus a passive scan of every 4xx the wall sees keep it that way. " +
  "The rules themselves are untouched; only the words. (2) Text-heavy: the Closure two-job banner " +
  "is one line with a ?, the attendance note rides on the bar chip, the certificate hint is eight " +
  "words. (3) The Home page had my own -102 Today section ABOVE the KPI cards, pushing them below " +
  "the fold, and nothing below had a height cap (2,041px, three screens). Cards are first again; " +
  "Today is a compact strip under them; every queue is a five-row box with its own scroll and a " +
  "View all link (Section maxRows, one place). (4) Sync: the watch cadence goes to once a day; a " +
  "REAL bug fixed - all three SheetChange/WorkbookChange creation sites deduped against OPEN rows " +
  "only, so a change the user had Ignored or Actioned was recreated by the next tick (the " +
  "'acknowledge kiya, wapas aa gaya'); a decision already taken now suppresses re-creation. The 37 " +
  "Open rows from the 14/08 first-sync are archived (Ignored, with a note), not deleted; the Sheet " +
  "Sync tabs each show their own open count so a stale pile can never hide behind the badge total. " +
  "(5) The certificate-upload report stayed on screen forever; there was no notice component at " +
  "all. Notice: cross always, success/info leave by themselves in 15s (progress bar, hover pauses), " +
  "errors never auto-hide. Used for the certificate report (refused lines stay) and portal-ID link. " +
  "-110: SMS. EnableX carries SMS (and later WhatsApp); email stays on SES - Umesh's scope. The " +
  "portal was explored end to end before a line was written: the credential in the repo's parent " +
  "was a portal LOGIN, not an API key; the account holds SMS project VIDYSEA_SMS_ENABLE_X, sender " +
  "VIDYSE (fulfilled), an ACTIVE campaign, and exactly ONE approved DLT template - the OTP one, " +
  "888579131 - whose wording differs from the OTP screenshot in circulation, so building to that " +
  "screenshot would have been rejected by the gateway on every send. lib/sms.ts is the twin of " +
  "lib/mailer.ts: env-only credentials from the app's own directory, never throws, every outcome " +
  "lands in the ONE MailLog with channel sms, and suppression is STRUCTURAL first (a non-production " +
  "DB or localhost auth means off, flag or no flag) with SMS_DISABLED as the MAIL_DISABLED twin - " +
  "so no wall run can text one of 167 real students. The template is data, rendered by " +
  "substitution into the approved text; a purpose with no configured template ID records skipped " +
  "and sends nothing, so QA-189/190's messages ship switched off until each is approved on DLT. " +
  "The public enrolment form gains a mobile-number path: the same hardened 6-digit challenge over " +
  "SMS, with three gates the email flow never needed because a code now costs money - a per-phone " +
  "cap independent of IP, a resend cooldown, and a global daily cap that raises a Notification to " +
  "Admin/Ops rather than stopping quietly. The verified number becomes the phone of record, exactly " +
  "as the verified address does on the email path. The first real SMS is a person's decision, not " +
  "a build step. " +
  "-109: two things Umesh caught. (1) 'Not eligible' was being said about students it was not " +
  "true of. Measured on production: BHA-SPIT-02 read it for all 31 students THREE DAYS into a " +
  "fifteen-day course; BHA-SPIT-01 for all 45 purely because that file's decimal hours never " +
  "parsed; CHI-DST-03 for all 45 with no import at all; on DST-01, 20 of 29 simply were not in the " +
  "import. A missing-data state and an unfinished course were both rendering as a negative verdict " +
  "about a real student, on the screen where certificates get decided. His answer shaped the fix: " +
  "the verdict belongs to the candidate JOURNEY - documents, registration, portal registration, " +
  "batch assigned, enrolled - so a student who has not finished enrolling gets no verdict at all. " +
  "One shared eligibilityVerdict now decides, with two gates: the journey gate, and a time gate - " +
  "below the bar while the course RUNS is progress ('42 of 60 hrs so far'), no imported hours is " +
  "'no portal hours yet', and 'Not eligible' waits until the course is actually over. The batch " +
  "Attendance tab, the Closure cards and the portal import grid all read that one function, and " +
  "each screen now reports the split - qualified / still short / no hours / not eligible - instead " +
  "of one lumped bucket. `qualified` keeps its old meaning so nothing else moved. " +
  "(2) A student registered from INSIDE the ERP got no mail. There were nine send sites and none " +
  "of them was POST /api/candidates - every registration mail lived on the public self-registration " +
  "paths, so the moment was simply never built; SES was live and sending all along. It sends now, " +
  "fire-and-forget so registration never fails on mail, and a phone-only student is recorded as a " +
  "skip WITH its reason rather than silently nothing - 'mail gaya ki nahi' is answerable per " +
  "candidate either way. The SMS fallback Umesh asked for needs a provider and its credentials, so " +
  "it is raised for him rather than half-built. " +
  "-108: certificate upload. The reason none of Manish's eight files would attach was not the " +
  "files - every one was named correctly - but that NOT ONE of the 39 roster candidates carried a " +
  "portal ID, and that field is the only key the matcher joins on. So the lookup was empty, every " +
  "file had to fail, and the screen blamed the file. The mapping was never missing either: the " +
  "portal import had already matched all 24 rows to those candidates BY NAME and stored each CAN " +
  "id - the importer just never wrote it back. It does now, on unambiguous matches only and never " +
  "over an existing id, plus a one-click Link portal IDs for everything imported before, so " +
  "nobody re-uploads a file they already imported. Bulk upload is preview-first: every file is " +
  "listed with the candidate it is going to and any of them can be changed BEFORE anything is " +
  "written, which is what makes a wrong auto-match fixable instead of silently committed; " +
  "unmapped files are discarded, an abandoned preview is cleaned up by the next one, and a url " +
  "this batch never staged cannot be attached. Each candidate card also takes a certificate " +
  "directly - no file name, no ID. And the screen now says everything up front: how many of the " +
  "roster carry a portal ID, who can take a certificate today and who cannot in plain words, this " +
  "batch's own expected file names to copy, and when a file cannot be matched it says the roster " +
  "has no IDs rather than blaming the file. Rule 45 still stands, shown in the preview and " +
  "enforced on the write, with a Mark Pass button beside it. " +
  "-107: the trainer dashboard gets the government-sheet upload - and the reason it was missing " +
  "was a DEAD TOGGLE, not an absent feature. The importer API has always gated on the " +
  "attendance.govt right, but every screen gated on the ROLE, so granting a trainer that right " +
  "changed nothing anywhere: Anuj Kumar carries it on production and never saw a door. All four " +
  "gates now read the right - the sidebar, the batch Attendance tab, the Daily Execution history " +
  "and the Home Today row - and Trainer joins the route ceiling so the grant can actually reach a " +
  "screen. It stays OFF for the Trainer role by default, so the trainers who only mark daily logs " +
  "see nothing new; a trainer Umesh grants it to gets the upload on their own dashboard. Pinned " +
  "both ways: without the right the API refuses (403), with it the importer opens, and revoking " +
  "closes it again. " +
  "-106: the portal ships the hours column in TWO shapes and we only read one. Found by smoking " +
  "the new qualification column against REAL production imports instead of fixtures: the live " +
  "Attendance Report 06-08-2026 on Bhadohi SPIT-01 carries hours as decimals (26.6, 73.99, " +
  "109.94), not hh:mm:ss, so all 28 matched rows stored null minutes and the whole batch read " +
  "no hours - nobody on a live batch could be judged qualified, including students well past the " +
  "60-hour bar. Decimal hours are read now, in the one function the whole app converts this " +
  "figure with, and deliberately strictly: anything that is not a duration or a plain number " +
  "still returns null rather than becoming a silent hour count. The same file is also missing a " +
  "days-present column we recognise, so the importer now REPORTS which expected columns a file " +
  "does not carry, and warns before committing when no row produced an hour figure at all - a " +
  "blank column is explained instead of looking like missing data. " +
  "-105: two more places the batch status was still printing the raw enum, both found in the " +
  "browser rather than by grep: the green running banner on a batch Overview said 'Closing' two " +
  "lines under a header chip that said 'Result Awaited', and the batches-list search index only " +
  "matched the enum, so typing what the screen shows found nothing. The banner uses the same " +
  "label map now, and the list is searchable by BOTH words - the client types 'Result Awaited', " +
  "an engineer reading an audit row types 'Closing'. " +
  "-104: found by driving the -102 resolve drawer in a real browser, not by reading code. Two " +
  "same-name candidates carrying no portal ID rendered as two IDENTICAL option rows, so the one " +
  "screen whose entire job is 'pick the right one' gave the operator nothing to pick on - the " +
  "exact case it was built for (Manish's two Sachins). Each option now carries the phone, which " +
  "is unique per candidate, plus the enrolment date and enrollment status, which is how a centre " +
  "register is actually ordered. " +
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

// What the public build-marker publishes is RELEASE_NOTE_CURRENT; RELEASE_NOTE stays the whole
// story for anything that wants it (and for the reader of this file).
export const RELEASE_NOTE = RELEASE_NOTE_CURRENT + " " + RELEASE_NOTE_ARCHIVE;
