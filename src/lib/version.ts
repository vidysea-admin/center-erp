// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional - set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
// KEEP THIS FILE ASCII. -117 first shipped its note with three Devanagari lines quoting Manish;
// tsc was happy, the Turbopack build was not ("failed to analyze ecmascript module" -> every route
// importing @/lib/version could not resolve), and the wall then ran against a stale .next. Romanise
// quotes here; the Devanagari belongs in the ledger and the manifests, which are read, not compiled.
export const RELEASE = "2026.08.14-204";
// -127 (QA-265): this file used to be ONE constant whose continuation lines carried no `+`.
// JS then applied automatic semicolon insertion: the first line became RELEASE_NOTE and the other
// 329 became dead no-op expression statements. Production published a 97-character note for an
// unknown number of releases. Joining them made the constant whole (32,613 chars) - and made the
// UNAUTHENTICATED /api/public/version endpoint publish the entire internal archive, which is worse
// than the truncation was. So the note is two constants: what THIS build changed, which is what a
// public build-marker is for, and the archive behind it, which stays in the bundle for anyone with
// the source. Bumping a release writes RELEASE_NOTE_CURRENT and moves the old text to the archive.
export const RELEASE_NOTE_CURRENT =
  "-204 puts the batch status buttons back. Since -112 a batch that had started could not be " +
  "completed, reopened, closed or cancelled from its own screen at all - the buttons were still " +
  "written in the code, but they sat inside the preparation checklist, and that checklist is " +
  "deliberately hidden once a batch is running. The card that replaced it did not carry them " +
  "across. They now sit on the batch itself, so every status has them, and each one still refuses " +
  "what it always refused. Separately, when an administrator completes a batch that still has " +
  "students nobody marked, those students are now recorded as having failed rather than as absent. " +
  "That is a deliberate choice by the person whose records they are: a student with no certificate " +
  "is not certified, and one word is wanted for all of them. Every such row is still written under " +
  "the reason the administrator types and is named individually in the history.";

const RELEASE_NOTE_ARCHIVE_203 =
  "-203 began as a repair to the checks guarding the planning table and turned up two real faults " +
  "while doing it. The download of that table printed the batch's start and end dates as \"Mon Aug " +
  "17\" - the weekday and the day, with no year - in columns people sort and filter on, while the " +
  "screen showed the same dates correctly. Four existing checks had confirmed that the file's " +
  "column NAMES matched the screen's and not one of them had ever looked at what was underneath " +
  "them. Separately, three places that accept a date now refuse text that merely looks non-empty: " +
  "the single character \"0\" was being read as the first of January 2000, a real date safely in " +
  "the past, and stored as though someone had recorded it. Both faults were found by checks written " +
  "in this release rather than by anyone using the system. The checks themselves were the starting " +
  "point: the table carries a card naming which column of the client's own planning sheet each " +
  "column came from, built by matching two lists against each other, and renaming either side left " +
  "the card empty while every heading was still present in the code - so the checks passed with the " +
  "card showing nothing at all. They now count what the card would actually display, and the " +
  "download is compared value by value against the screen.";

const RELEASE_NOTE_ARCHIVE_202 =
  "-202 gives a trainer's hiring record a way to be corrected. The dates on a trainer's Nomination " +
  "and TOT card - when the nomination went out, when it went to NSDC, when NSDC answered, when the " +
  "eligibility fee was paid, when the TOT was scheduled and when it finished - were written only as " +
  "the trainer moved through the hiring steps, and no screen anywhere could change one afterwards. " +
  "A trainer whose status had been set directly, which is what happens when someone joins us before " +
  "their paperwork catches up, ended with five of those six permanently blank and no way to fill " +
  "them in. The same card now has an Edit mode covering all of them, plus the NSDC TR ID, which the " +
  "page had been telling people to record there while offering nowhere to do it. Corrections are " +
  "open to the same people who move a trainer along - an administrator, the operations team, and " +
  "the centre - and each one is recorded on the trainer's Activity tab with the name of whoever " +
  "made it. A date that records something already done can no longer be set in the future, on this " +
  "screen or on the one that sets a status directly, which until now accepted any date at all. And " +
  "where a correction changes something else - the availability date, a batch's lateness flag, or " +
  "the fee already entered in Costs - the screen says so instead of letting the two quietly differ. ";

const RELEASE_NOTE_ARCHIVE_HEAD =
  "-201 stops the sheet sync dropping rows without telling anyone. The client's team cleared the " +
  "TC Status on five centres that had been Approved, and only one of the five reached the review " +
  "queue. The sync finds a row's centre by its registration number, but it only ever looked at the " +
  "number recorded on the centre itself, and most of the sheet's numbers are recorded on the " +
  "centre's individual job-role rows instead. When it could not find the centre it did not say so " +
  "- it compared the sheet against nothing, and a cleared cell matched that nothing exactly, so " +
  "the row disappeared and the run reported success. Where the cell was not empty the same gap " +
  "filed a change belonging to no centre, which nobody can act on. The sync now finds the centre " +
  "either way, and a row whose number no centre carries is refused out loud and named in the run's " +
  "own result, instead of being counted as agreement. ";

// The archive. Everything this product has shipped, newest first.
const RELEASE_NOTE_ARCHIVE =
  RELEASE_NOTE_ARCHIVE_203 +
  RELEASE_NOTE_ARCHIVE_202 +
  RELEASE_NOTE_ARCHIVE_HEAD +
  "-200 makes the previous release's headline fix actually work. -198 said it had stopped the " +
  "planning form saving a different checklist from the one it had just shown you, when a centre " +
  "already has a certified trainer and the training steps are correctly left out. It had not: the " +
  "form asked the server for that trainer's record, the server never included the trainer's " +
  "identifier in its answer, so the form had nothing to send and the batch was still created " +
  "without a trainer - and the plan attached to it came back with the training steps in it. Five " +
  "steps on screen, eight on the batch. The server now returns the identifier, and the check that " +
  "guards this no longer looks at whether the code was written a certain way; it plans a batch the " +
  "way the screen does and compares the two lists. Also: a completion date sent as empty, zero or " +
  "null was still being read as today for two of those three; all of them are refused now. " +
  "-199 leaves one button where there were two. Planning a batch was offered twice on the same " +
  "screen - once in the page header and once again in a panel a few rows below it, both reading " +
  "Plan a batch. The one in the header is the one that stays: it opens the planning view and the " +
  "form together, in a single click, from the same place as New Batch. The panel below no longer " +
  "appears at all until that button is pressed, so the planning view is the table and nothing " +
  "else until you ask to plan something." +
  "-198 comes from actually using the new planning screen on the live site rather than reading it. " +
  "Planning a batch showed a plan with the trainer-training steps correctly left out, because the " +
  "centre already has a certified trainer - and then saved a batch with those steps back in, " +
  "because the plan was worked out for that trainer and the batch was created without one. The " +
  "checklist you approve is now the checklist that gets stored, and the screen says which trainer " +
  "it is about to put on the batch. Two buttons reading Plan a batch were stacked on the same " +
  "screen; the one in the page header now appears only where it is a way in, and it opens the form " +
  "instead of leaving you at a prompt asking for the same words again. A date recorded as already " +
  "done was refused a year out but accepted for tomorrow, and an empty one quietly became today - " +
  "both are refused now, on the same calendar-day footing the rest of the system uses. And the " +
  "planning-column work has carried a wrong internal reference since it shipped, in twelve places " +
  "including two test names, so every test run printed the wrong one; it now carries its own." +
  "-197 repairs three things -196 broke or left behind, all found by review rather than by use. The " +
  "planning screen lost its Preparation tab last release, and five links on the home page still " +
  "pointed at it - including a button reading Preparation board - so asking for the centre and " +
  "job-role readiness list handed you a table of batches instead. That list now lives on the home " +
  "page itself, complete rather than the first eight rows, and the links say what they open. The " +
  "bigger one: every save on the new planning screen left the table stuck on Loading, because the " +
  "screen asked for fresh rows by emptying the ones it had, which is not something it was watching " +
  "for. Editing a date, deleting a batch or creating one now shows the result immediately. The " +
  "Excel download sitting above that table still carries every live batch, including the started " +
  "ones the table no longer lists, and it now says so on the button instead of quietly disagreeing " +
  "with the screen. A date recorded as already done can no longer be set in the future, which the " +
  "rest of the system has always refused. And the readiness line inside the planning form used to " +
  "go silent whenever the page filter named a different centre from the one being planned - it " +
  "asks about its own centre now, and says so when there is nothing recorded." +
  "-196 makes batch planning one screen instead of three. Planning a batch used to open a panel " +
  "that could work out the dates and could not create the batch, so the plan was worked out once " +
  "and then typed in again somewhere else; a separate Preparation tab listed what was blocking " +
  "each centre, away from the moment anyone could act on it. There is now a single Planning tab: " +
  "pick the centre, the job role, the start date and how many candidates the batch is for, and " +
  "saving creates the batch AND keeps the backward plan on it as a tick-off checklist. What is " +
  "still blocking that centre is shown right there while the date is being chosen. The table below " +
  "is the planning sheet, one row per batch, and it now holds only the batches that have not " +
  "started - once a batch starts, its row moves to the Batches tab by itself. An Edit switch turns " +
  "the table from a report into a form: dates were already changeable on three columns and nothing " +
  "said so, so nobody found them. With it on, every date this screen owns is outlined and " +
  "editable, an Admin can delete a batch from its row, and the dates this screen does not own are " +
  "greyed with a link to where they are recorded. A date typed for a step that is already done is " +
  "now stored as typed - it used to be silently replaced with today, so a sheet copied in a week " +
  "late recorded the wrong week." +
  "-195 stops the product guessing who a shared plan link belongs to. Four earlier attempts worked " +
  "it out from something about the person - the batch, then the phone number, then their position " +
  "in the centre list, then their name and role - and each one either merged two people or split " +
  "one. The last was the clearest: two different people who happen to share a name and a role were " +
  "treated as one, so sending to either cancelled the other link. There is no detail about a person " +
  "that is safe to use as their identity. So a plan is now sent by choosing one of the centre " +
  "recorded people, the choice travels with the link, and a link that does not say which person it " +
  "is for is refused rather than guessed at. Editing the centre contact list also used to renumber " +
  "everybody, which quietly detached links from the people they were sent to; it no longer does." +
  "-194 fixes, for the third time, who a shared plan link belongs to - and this time the answer is " +
  "the person rather than something about them that the product lets change. A contact was " +
  "identified by its POSITION in the centre list, so removing one contact moved everybody below it " +
  "up a place, and sending the plan to whoever had moved into a freed place cancelled the previous " +
  "occupant link. A contact is now identified by its own record, which does not move when the list " +
  "is edited. The phone number has been dropped from that identity entirely: keeping it as a " +
  "fallback meant somebody shared with once without a number and once with one counted as two " +
  "people. A link created before this identity existed can now be replaced properly instead of " +
  "living on beside its replacement. And the rule deciding who may see the centre staff list is now " +
  "the same rule that decides who may send - it disagreed in both directions, showing the list with " +
  "phone numbers to somebody who could not send, and hiding it from somebody who could." +
  "-193 carries two things. The planning table now uses the same column names as the planning " +
  "sheet: every one of the sheet columns was already there, but the screen had shortened them, and " +
  "two read the same - Starts and Ends each appeared twice, once for the trainer training and once " +
  "for the batch - so two different dates answered to one word. The names are written out now, no " +
  "two alike, and a card under the table quotes the sheet own heading for each column. The second " +
  "is more serious and it was found by an independent check on the last release: a shared plan link " +
  "was tied to a phone number rather than to a person, so a centre that records one landline for " +
  "two of its people had them cancelling each other links - the very thing the last release set out " +
  "to stop. A link now belongs to the person it was sent to. The same page also stopped handing " +
  "centre staff names and phone numbers to anyone who could merely view the batch." +
  "-192 gives the planning table the same column names the planning sheet uses. Every one of the " +
  "sheet column was already there, but the screen had shortened the names to a word or two, and " +
  "two of them read the same - Starts and Ends each appeared twice, once for the trainer training " +
  "and once for the batch - so somebody holding the sheet could not find their own columns and two " +
  "different dates answered to one word. The names are now written out, no two are alike, and a " +
  "card under the table quotes the sheet own heading for every column so the two can be matched " +
  "without guessing. The download already used the longer names and the screen did not, which " +
  "meant one column had two names depending on where you looked; both now say the same thing." +
  "-191 makes a shared plan belong to a PERSON. The batch plan screen now shows who already has " +
  "the plan - their name, their role at the centre, their number and their own link - and, beside " +
  "it, the people that centre records, so a plan is sent by picking a person rather than by typing " +
  "one. That answers the question the product could not answer before: who is this going to, seen " +
  "before it goes. It also closes something that would have gone wrong quietly the day plans were " +
  "sent to more than one person: a link was cancelled for the whole batch, so sending the plan to " +
  "the Principal would have killed the SPOC working link and told neither of them - the first sign " +
  "would have been someone reporting a dead link days later. Re-sending now replaces only that " +
  "person link and leaves everyone else untouched." +
  "-190 makes two more refusals leave a mark, and puts a guard on a word. If a sheet source was " +
  "set up with no column mapping at all, or with none of its columns marked as the identifier, the " +
  "run was correctly refused but nothing was written down - so the source went on displaying the " +
  "result of its last good run while it had in fact stopped working. Both now record the refusal, " +
  "the same way every other refusal here does. The word is in the message about incomplete runs: a " +
  "line whose registration number is claimed by two centres is skipped ENTIRELY, while a line whose " +
  "job role cannot be placed keeps its centre details and loses only its job-role figures. That " +
  "distinction was written last release and nothing was checking it, so it could have been reworded " +
  "away without anything failing." +
  "-189 fixes three edges of the last two releases, all found by an independent check. If a sheet " +
  "had TWO columns with the same heading and that heading was in use, the sync quietly read the " +
  "second one and reported success - so a government approval could land against the wrong job " +
  "role with nothing said. There is no way to tell which of two identically named columns was " +
  "meant, so the run is now refused and names the column. Second, a refused run left no mark: the " +
  "source kept showing the result of its last good run, and on the daily schedule that meant the " +
  "screen said all was well while nothing had run for days. A refusal is now recorded before it is " +
  "raised. Third, a run can be incomplete for three different reasons and only one was ever " +
  "reported; the last release merged two of the three, which left the same problem for every pair " +
  "involving the third. All three are reported together now." +
  "-188 closes three gaps in the change the last release made, all of them found by reading it " +
  "rather than by anything going wrong. A sheet line that left the job role EMPTY was quietly " +
  "passed over while the run still reported success - which is the very thing the last release set " +
  "out to stop, so an empty job role is now reported as loudly as a wrong one. The message about " +
  "skipped lines said the whole line was skipped when only its job-role figures were; the centre " +
  "details on that line are still read, and the message now says so. And a sheet that both names " +
  "its job-role column and pins a job role on a figure column is refused outright instead of being " +
  "warned about in help text - that combination would write one job role for every line of a " +
  "centre. Two reasons for an incomplete run are also reported together now rather than only the " +
  "first one." +
  "-187 lets the centre sheet say something about one job role at a time. The client master lists " +
  "one line per centre and job role with a single status column, but a sheet could only ever be " +
  "connected the other way round - one column per job role - so that master could not be connected " +
  "at all. Connecting it anyway would have been worse than leaving it: every line for a centre " +
  "would have written the same job role, the last one silently winning. A sheet can now name its " +
  "job-role column, and each line is matched to that centre registration number own row for that " +
  "job role, so the scheme is settled by the number rather than guessed from a name - two job roles " +
  "here share a name and differ only by scheme. A line naming a job role the centre has no target " +
  "for is left alone and reported, instead of being written somewhere plausible." +
  "-186 changes nothing you can see. It is the third attempt at one check - the one that keeps the " +
  "report headings on a single line - and this time the check finds the heading by the only fact " +
  "that actually matters: the heading sits inside that box, so that box is where it could wrap. " +
  "The two previous attempts each identified the heading by something incidental - first by how its " +
  "styling was spelled, then by which handler it happened to call - and each time the check could " +
  "be satisfied by a decoy while the real heading was left unprotected, or could report a fault on " +
  "a heading that was perfectly fine. Every check written here was also run against the three " +
  "earlier versions of itself, so each one is shown catching something those versions let past." +
  "-185 changes nothing you can see. The check added two releases ago to stop the report headings " +
  "breaking onto two lines was itself wrong in both directions, and this repairs both. It read only " +
  "the first button it found in the file, so another button written earlier could stand in for the " +
  "heading and the check would pass while the heading was unprotected. It also insisted the " +
  "headings style be written in one particular order, so simply rearranging it, without changing " +
  "anything a reader would see, made the check report a fault that did not exist. It now finds the " +
  "heading by what it does rather than by where it sits or how it is spelled, and every such " +
  "heading has to pass rather than the first one found." +
  "-184 changes nothing you can see. It repairs two of the automated checks that are supposed to " +
  "stop earlier problems coming back, both of which could be satisfied without the thing they " +
  "check being true. One guarded the report heading against breaking onto two lines and could be " +
  "contented by the words appearing anywhere nearby rather than on the heading itself. The other " +
  "guarded the warning line above the report, which must stay visible rather than folding away " +
  "behind a click, and it was reading the position of the test that decides whether to draw the " +
  "warning instead of the position of the warning. Each repair was demonstrated by first breaking " +
  "the screen in the exact way the old check allowed and confirming the new one refuses it." +
  "-183 stops the report headings breaking onto two lines, which is where this started. The " +
  "last two attempts widened the columns, and the widths were measured against a heading with " +
  "no filter control on it - the control takes sixteen pixels, so the longer names still wrapped. " +
  "Adding a few more pixels would have worked until the data grew, because that control only " +
  "appears once a column has more than one value in it. Headings simply refuse to wrap now, " +
  "whatever width they are given, and a column can still be dragged narrower if you want it that " +
  "way." +
  "-182 finishes two things the last release only appeared to do. The wider column names were " +
  "set but never reached the screen - the table was sharing its space equally between columns " +
  "and ignoring them - so headings like In training and Not approved still broke onto two " +
  "lines, which was the original complaint. They fit on one line now. And the tidier list of " +
  "columns, which was asked for on the report and only there, had been applied to every table " +
  "of its kind; on the batch planning table it merged two different dates that happen to share " +
  "a name, so hiding one hid both. That list is now the report's alone and every other table " +
  "behaves exactly as it did before." +
  "-181 is a test fix, not a product change: nothing on any screen moves. The check that " +
  "guards the report's always-visible caution had a hole in it - it confirmed the caution sat " +
  "after the explanations card, which is not the same as confirming it sits outside every such " +
  "card. Wrapping it in a second one would have passed while the rule was broken. The check now " +
  "requires every card opened before that line to have closed, and the exact case it used to " +
  "miss is proved failing." +
  "-180 puts back something the last release quietly removed. Every figure on the report is " +
  "supposed to say where it came from - the client's master sheet, or our own records. When " +
  "the explanations were folded into a card, the four figures taken from the client kept that " +
  "label and the three taken from our records lost it, because those three had been showing a " +
  "percentage instead. All seven now name their source whether the card is open or shut. The " +
  "note under them also stops saying two numbers are close and gives the actual proportion " +
  "instead, so the reader judges rather than being told." +
  "-179 gives the report columns their real names. The screen had been shortening them to " +
  "three or four letters while the Excel download spelled them out, so one column had two " +
  "names and downloading quietly renamed every one of them. They now read the same in both " +
  "places. The width that saved is not missed, because a column can already be resized, " +
  "hidden, or scrolled past - that choice always belonged to the reader. The list of columns " +
  "you can switch on and off was also repeating itself: the same five measures appeared once " +
  "per job role, thirty-four entries with twenty exact duplicates. Each name is listed once " +
  "now, with a count of how many columns it covers, and job roles are listed separately - so " +
  "hiding one measure everywhere and hiding one whole job role are both a single click." +
  "-178 tidies the top of the report. The block explaining where each column's numbers come " +
  "from used to sit open all the time - seven definitions and a note, pushing the table itself " +
  "down the page on the one screen people open to read the table. It folds into a card now, and " +
  "opens when you want it. The one line that changes how the figures should be read stays " +
  "visible outside the card, because a caution you have to go looking for is not a caution." +
  "-177 gives the report the two things it was missing at the front. The first two columns now " +
  "carry their own headings - Batch Location and Status - and both can be filtered, so you can " +
  "ask to see only the approved centres and get exactly those. Until now those headings were " +
  "blank: the column and its figures were on screen, and the little control that filters them " +
  "was never drawn, which is why filtering by status was not possible even though the status " +
  "was right there. Those two columns also stay in place when you scroll sideways, so a long " +
  "row of figures always has the centre name beside it. And the meaning of Mobilised has been " +
  "corrected: it now counts people actually enrolled onto a batch, not everyone typed into the " +
  "system, so it and In training describe two genuinely different stages instead of nearly the " +
  "same one." +
  "-176 makes the report something you can work in rather than only read. The approval " +
  "verdict was shown as a small label next to each centre, which looked tidy and turned out to " +
  "be the wrong trade: a label cannot be filtered, sorted, or carried into a download, and " +
  "filtering by it is the whole reason anyone wants it. It is a proper column now, and it " +
  "matters most on the seven largest centres, whose job roles are part approved and part still " +
  "undecided. The centre and its status stay in place while the figures scroll sideways, so a " +
  "long row never becomes a set of numbers with no name attached. The report also stops " +
  "quietly absorbing anything it does not recognise: a status word nobody taught it used to be " +
  "counted as an empty cell, under a heading that said the cell was empty - those are now " +
  "listed by name on the screen instead. Separately, the tool that copies live data to a " +
  "developer machine no longer copies the share links that grant access to a candidate record." +
  "-175 makes the report say what a blank actually means. It used to report how much of the " +
  "target was approved, and everything else read as zero - which quietly merged two completely " +
  "different things: a centre the government has refused, and a centre nobody has decided about " +
  "yet. On the current data that second group is a third of the whole target and not one row " +
  "anywhere says refused, so almost all of what looked like nothing approved was in fact nobody " +
  "having filled the sheet in. The report now separates the three - approved, not approved, and " +
  "no verdict yet - and the three always add back to the target, so any row can be checked by " +
  "eye. Each centre also carries its own verdict beside its name, because that is the level the " +
  "question gets asked at. The full split per job role is in the Excel download, where pivoting " +
  "happens. Separately, planning a batch now offers only centres and courses that are actually " +
  "approved, and says how many were left out rather than quietly showing a shorter list." +
  "-174 finishes the batch planner. The Plan a batch drawer used to ask for a date and nothing " +
  "else, so it could not know WHICH CENTRE you meant - and everything the last three releases " +
  "taught the system stayed out of reach of the one screen a person opens to plan. It now asks " +
  "for the centre, and once you name one it tells you the earliest that centre could actually " +
  "start and why, warns when the date you typed is inside that window, and drops the trainer-" +
  "certification steps when the trainer teaching there is already certified. Naming a centre is " +
  "optional - without one the plan is exactly what it always was, because people share a plan " +
  "before a centre is picked. The planning table also downloads as Excel now, the same way the " +
  "report does, carrying the same rows the screen shows." +
  "-173 stops a save from pretending. Each screen has a list of the fields it is allowed to " +
  "write, which is right - it is what keeps a request from setting something nobody meant to " +
  "expose. What was wrong is that it did this in silence: send a field the screen does not " +
  "accept and the save came back successful with that field untouched, and there was no way to " +
  "tell what had been saved from what had been quietly dropped. It was found the honest way, by " +
  "a test that set three trainer dates only the certification process may stamp, got a success " +
  "back, and read them as empty. There it only proved the test wrong; in front of a person it " +
  "means they save something, the screen agrees, and nothing changed - and nobody finds out " +
  "until someone reads that record weeks later. Saves now name anything they did not write. " +
  "Nothing became writable that was not before: the rules are exactly as strict, they simply " +
  "say so. Ids and timestamps a screen sends back unchanged are left out, because those are not " +
  "attempts to write anything." +
  "-172 puts the total row back on the report. The figures were being worked out and sent to " +
  "the page all along, and the page never showed them - so anyone wanting the overall number " +
  "had to add twenty rows by eye, which is the exact habit the report was built to end. The " +
  "client own pivot has that row, and the approved total is the number they speak in when they " +
  "say what they can actually work with. It now sits under the table with a figure for every " +
  "job role as well as the overall one, and it follows whatever the table is showing: filter or " +
  "search the list and the totals describe what is in front of you, not the full set. A standing " +
  "check now fails the build if that row ever goes missing again, because the version that was " +
  "missing looked completely finished from the outside." +
  "-171 adds the planning table the client keeps in a spreadsheet, as a Planning tab beside the " +
  "batches: one row for every live batch, with where its trainer has got to and where the batch " +
  "itself has got to, side by side. Eighteen columns, the same ones they track today. The part " +
  "worth explaining is what it deliberately does NOT do: it does not copy the trainer details " +
  "onto each batch. A trainer does their training-of-trainers ONCE and can run up to four " +
  "batches, so copying those dates onto every row would leave four copies of one fact, and " +
  "sooner or later they stop agreeing. Every trainer column is read from the trainer, which is " +
  "why one trainer running two batches shows the same date on both rows - it is the same date. " +
  "The mobilisation column shows a state and a headcount, and the headcount is counted from the " +
  "batch roster each time rather than stored anywhere. Where a trainer is already certified, " +
  "the training columns read Not needed rather than sitting empty, because an empty cell reads " +
  "as nobody having done it yet. And three dates that had nowhere to live before - the SIDH " +
  "profile check, the eligibility check, and when the result is expected - can be filled in " +
  "directly on this table, since that is where the person tracking them is actually working." +
  "-170 adds the report the client has been asking for: every centre down the side, every job " +
  "role across the top, and five figures under each one - the approved target, how much of it " +
  "the government has actually approved, how many candidates have been taken on, how many are " +
  "in training, and how many have passed. It is ONE table, not two. Their own workbook keeps " +
  "two pivots, one for approved centres and one for the rest, and that was nearly built as two " +
  "reports - but a spreadsheet keeps two because it cannot do better, and the ask was the " +
  "opposite: put the approved figure in as a COLUMN so both readings sit in one place, because " +
  "reports keep multiplying and the person at the end gets fed up. Every column says on screen " +
  "where it came from, since two of the five come from the client sheet and three are ours, " +
  "and any argument about the report starts there. Percentages are taken against the approved " +
  "figure rather than the total, which is how they described the funnel. A row whose numbers " +
  "cannot all be true is flagged rather than shown straight-faced. And the screen says plainly " +
  "that the mobilised count currently tracks those in training, because candidates are entered " +
  "when they enrol and the pool before that is not recorded yet. It downloads as Excel, with " +
  "the same numbers and the same notes on where they came from." +
  "-169 lets a correction made in the client sheet reach the row it is actually about. The " +
  "government does not approve a centre as a whole - it registers the centre for each scheme " +
  "and gives every registration its own number, so one building can hold several. The ERP " +
  "could only remember ONE number per centre, and used that number to decide which centre a " +
  "sheet row belonged to. Any row carrying one of the other numbers matched nothing: it was " +
  "reported as a change with no centre attached to it, which nobody could act on, and the run " +
  "still finished saying everything was fine. On the live data that was twenty of the " +
  "thirty-five numbers in the sheet. A row can now carry its own registration number, and the " +
  "sync uses that to find the centre - falling back to the old behaviour when nothing carries " +
  "it, so existing sources are untouched. The job role is still chosen by the mapping, because " +
  "one registration usually covers several. If the same number is claimed by two different " +
  "centres the row is skipped and the run says so plainly instead of picking one. The tool " +
  "that fills these numbers in proposes them for a person to check before anything is written." +
  "-168 makes the product give ONE answer to the question of how soon a centre could start a " +
  "batch. There were four, and they disagreed. The batch form worked one out in the browser, " +
  "the save checked it again its own way, an edit checked it a third way, and the planner added " +
  "a fourth that also looked at whether a room was free and whether the trainer was already at " +
  "capacity. The first three knew nothing about rooms, so on a centre whose only room is booked " +
  "they did not disagree politely - they said nothing at all, and a start date that could never " +
  "work was accepted without a word. Silence about a date that cannot work is worse than a " +
  "wrong date, because there is nothing there to doubt. All four now read the same calculation, " +
  "and they explain it in the same words: the mobilisation lead, the trainer availability or " +
  "batch cap, and the first free room. When a centre has no room at all, the screen now says " +
  "plainly that planning is blocked until one exists, instead of offering a date." +
  "-167 is a safety release with no visible change: it stops the maintenance scripts from " +
  "being able to hit the live database by accident. Seventeen of them write - they seed data, " +
  "run migrations, clean up test records, one of them deletes - and until now, if the variable " +
  "naming the database was simply absent, eight of those quietly fell back to the LIVE one. Not " +
  "an error, not a prompt: a default. One forgotten flag and a seeder would rewrite live " +
  "settings and reset an administrator password, and the run would look completely normal. " +
  "Every script that writes now asks a single shared guard first. With no database named it " +
  "stops and says so instead of guessing; naming the live database is refused on its own, " +
  "because the name alone is not consent; and reaching it deliberately takes a second, " +
  "explicit instruction. The sample seeder writes THROUGH a running server, so it also refuses " +
  "when pointed at anything other than a local one. A standing check now sweeps every script " +
  "in the repository so a new one cannot bring the old default back." +
  "-166 lets the client's own master sheet correct one thing it never could: whether the " +
  "government has approved a particular job role at a particular centre. That verdict is " +
  "recorded per centre AND job role - one centre can be approved for one course and not " +
  "another, and each row even carries its own TC number - but the sheet sync could only ever " +
  "set it for the centre as a whole, while every count in the product reads the per-row value. " +
  "Two different places, and nothing connected them. So a correction made in the sheet simply " +
  "did not arrive, and the sync reported a clean run while doing nothing. The mapping now " +
  "accepts TC Status and TC ID per job role, the same way approved targets have always worked, " +
  "and a change to either shows up for review like any other. Two deliberate limits: a blank " +
  "cell is treated as a real answer rather than a missing one, because blank is what the master " +
  "actually says on the rows that disagree today; and a verdict for a job role the centre has " +
  "no target on is refused with the reason rather than quietly creating that target, since a " +
  "status must not invent the thing it describes." +
  "-165 is the correction pass on -164, and every item in it was found by review rather than by " +
  "a user hitting it. The worst was quiet: the new rule that drops TOT steps for an already-" +
  "certified trainer was also DELETING what people had recorded. A regenerated plan was rebuilt " +
  "from scratch, so any step the new plan no longer wanted disappeared along with its tick, its " +
  "note and its owner - and that happened on the ordinary path, the moment a trainer was marked " +
  "certified and the start date was edited. A plan may now move a date; it may never erase what " +
  "somebody wrote down. Next: the new SIDH-portal mapping step had a default that placed it " +
  "BEFORE the trainer TOT it depends on, so the checklist asked for the portal mapping two days " +
  "before the certification that makes it possible. It now sits after TOT and before " +
  "mobilisation, and steps that fall on the same day keep their real order. The centre-scoped " +
  "planner also read CANCELLED batches when deciding which trainer a centre uses, so a batch " +
  "nobody is running could remove the TOT steps; it reads live batches only. A centre with no " +
  "room at all was handed an earliest start date it could not possibly meet, with no warning - " +
  "it is now told plainly that the plan is blocked until a room exists. And the skip now also " +
  "covers the step that asks whether the trainer is ready for a TOT they have already " +
  "finished." +
  "-164 makes batch planning answer the question people actually ask. Until now the planner " +
  "produced the same seven steps for every batch and only ever answered one question: if you " +
  "pick this date, what has to be finished by when. It could not skip a step, and it could not " +
  "tell you whether the date was possible at all - so a batch whose trainer was already " +
  "certified still got Trainer TOT deadlines nobody had to meet, and a date in the past was " +
  "accepted in silence, handing back deadlines that had already expired before they printed. " +
  "Now a batch whose trainer is certified simply has no TOT steps. A new step - trainer mapped " +
  "on the SIDH portal - sits between TOT and mobilisation, with its own lead time in Admin " +
  "Defaults alongside the other seven. And the planner can be pointed at a centre: it then " +
  "reads that centre's own trainer, and reports the earliest date the centre could realistically " +
  "start, with the reason - mobilisation lead, the trainer's availability or cap, and the first " +
  "free room. The room list has existed since the first schema and no planning path had ever " +
  "read it. Asked without a centre, the planner behaves exactly as it did before." +
  "-163 closes a hole that let a wrong row exist forever. A centre's target is stored per job " +
  "role, and until now the job role was part of the row's IDENTITY rather than something you " +
  "could correct - so if a target landed under the wrong job role, sending the right one simply " +
  "created a SECOND row and left the first behind, taking that centre's target UP instead of " +
  "moving it. Nothing anywhere could delete the wrong row either. That is not hypothetical: two " +
  "rows carrying 280 each sit under a job role the client's own sheet does not have at all, which " +
  "puts 560 of target in the wrong column while the grand total stays right - the reason it " +
  "survived every check that only looked at totals. A target can now be MOVED to the job role its " +
  "own source row states: it travels whole, carrying the government TC identity that belongs to " +
  "it, the move is audited and needs a written reason, and if the destination already has a " +
  "target the move is refused by name rather than quietly merging two government approvals. " +
  "-162 is Manish sir's release. Three things he reported on 20 August had gone a month of " +
  "releases without being opened, and all three were about a screen refusing to say what it knew. " +
  "On a finished batch both Mark Completed buttons were dead AND silent - the very fact that " +
  "switched them off was the fact that hid the explanation beside them - so an operator met a " +
  "control that would not move and no reason why. They now say they are already signed off, when, " +
  "and that an Admin can reopen the batch from the Overview tab; and Save no longer offers itself " +
  "on a frozen batch only to be refused by the server in a banner at the top of the page. The " +
  "certificate line that read '39 already have one, 9 without a certificate number' was describing " +
  "ONE group of nine twice, which reads as eighteen people; it now names the nine once and says " +
  "plainly that none of them carries a number yet. And Total Attendance was a single percentage " +
  "averaged over two meters that cannot be averaged - the government portal's roster and our own " +
  "daily logs, added together into one denominator. The government meter is the one that decides " +
  "who qualifies, so it is the headline now, our own logs sit beside it, and the line says they " +
  "are counted separately and never added. " +
  "-161 is the third correction of one thing, and the honest headline is that the previous two " +
  "releases said this was finished and it was not. Wherever this product lists people, a name on its " +
  "own is not enough to tell two of them apart - and the screen that needed it most was the " +
  "attendance table, where a student with no portal ID had nothing at all beneath their name. That " +
  "exact line was written down as a known problem a day ago and three rounds of this work walked " +
  "past it, because each round searched for the shape of the previous fix instead of the mistake. " +
  "It is fixed now, along with the tap-to-mark-present grid a trainer uses to record that a person " +
  "was here, which had the same flaw and was on no list at all. The rule itself was being written " +
  "out by hand in ten different places, including inside the feature whose whole job is spotting " +
  "duplicate candidates; there is one definition now and every screen reads it. And the note the " +
  "last release published quoted the requirement while shipping only half of it: the requirement " +
  "says show the portal ID when there is one and the phone otherwise, and only the phone was ever " +
  "shown. " +
  "-160 is the third attempt at one thing, and this time the counting is done by the machine rather than by hand. Twice now a release has fixed the places where this product lists people by name alone - which on a roster where two students share a name identifies nobody - and twice the count was wrong. The check found a banner still printing the same name three times over in plain sight, four lines below a line that had just been corrected. So the guard no longer looks for the shape of a fix; it looks for the mistake itself, and it found the survivors on its own before anybody was asked to look again. Every list of people on the batch screen now reads one definition of how a person is named - their name with their phone beside it - and that definition now lives in one place for the whole product, where the previous release had left three copies of it, including one on the very screen it linked people to. " +
  "-159 finishes something -158 only started. -158 stopped one tooltip on the batch screen from naming students by name alone - which on a roster with two students of one name identifies nobody - and the check found the SAME sentence still being written one line above it. Counting properly found four places on that screen where people are listed by name: the complete-batch plan, the two blocker warnings, and the portal-ID line. All four now read one shared definition of how a person is named here - the name with their phone beside it, which is what the contract already required and what a centre uses to tell two people apart on a call - and the check that guards it looks for the whole family rather than the one line that was fixed first. Two of this product own safeguards were repaired in the same pass: one was reading source code with the comments left in, so a comment quoting the right words could satisfy it, and another was watching a fixed-size window that was about five lines of text away from losing sight of the thing it checks. " +
  "-158 answers the two riders the check on -157 filed, and both are about the same habit: a thing that " +
  "LOOKS like it is watching. The Certification warning that -157 added named the students with no portal " +
  "Candidate ID by name alone - so on the one roster this whole week has been about, where two students " +
  "share a name, it read that name twice and identified nobody. It carries the phone now, which is what " +
  "the recovery screen shows and what a centre actually uses to tell them apart. And the check that is " +
  "supposed to keep that warning on the screen turned out to be watching a phrase the DISABLED BUTTON " +
  "also carries, so the entire warning could be deleted and the check would still pass. It now looks for " +
  "the sentence a person reads, proved by deleting the warning and watching it go red. " +
  "-157 is one fix and one correction, and the correction is the point. -156 built the rule that certification cannot complete while an enrolled student has no portal Candidate ID - at both doors, the typed one and the automatic one - and told you, in this very note, that the Closure screen would say WHO was missing one before anybody pressed anything. It did not. The figure was computed and sent, and no part of the screen read it, so on such a batch the certification tick simply stopped arriving while the button still looked ready to press, and the only explanation came as an error after the click. That is the exact complaint the rule was built to end, one step earlier, and the check caught it before anyone had to report it. Now the Certification section names those students, links to the screen that recovers most of their IDs from where they were misfiled, and the button is disabled while any of them is outstanding - the same shape as the line beside it that has always said how many passed candidates are still waiting on a certificate. " +
  "-156 answers a checker's FAIL and finishes a story the same afternoon started. One number on the " +
  "batch Closure tab counted unmatched portal rows differently from the three chips beside it, " +
  "because it read a bucket the enrolment gate empties while they read the row itself; the line now " +
  "counts rows, and says out loud that it cuts across the groups above rather than being a seventh " +
  "one. Where two students of one name are waiting on a single portal row, no screen tells either " +
  "of them it is theirs any more - not the batch tab, not the roster, and not the student's own " +
  "page, which is the reader least able to check. A tooltip that promised hours now reads what the " +
  "row actually holds, including a row whose hours column could not be read. " +
  "And from the check of -155: the Portal ID health screen was showing a centre-scoped user every " +
  "enrolled student in the database without a portal ID - names, phones and batch codes from " +
  "centres they have no scope over - and that group is now scoped like the other five. " +
  "Certification could still complete itself on a batch full of students with no portal Candidate " +
  "ID, because the gate was written on the hand-typed door and per-candidate batches derive instead " +
  "of typing; both doors ask one question now. THE HALF -156 CLAIMED AND DID NOT SHIP: it said the " +
  "Closure screen named who was missing one - the payload was there and no screen read it, so the " +
  "derived tick stopped arriving behind a button that still looked live. The check caught it and " +
  "-157 is the screen. A blank Candidate ID is stored as absence rather than an empty " +
  "string, so the second person without one is no longer refused as a duplicate identity. And a " +
  "portal row that names no batch is held for a person when its student is on two - the ID says " +
  "who, never which batch. " +
  "-155 is the root of the Sachin Kumar story, closed at every door it touched. Measured on live: 55 " +
  "candidates carried their government portal Candidate ID in the wrong field - id_reference, the " +
  "nearest-looking option on a mapping screen that never offered the right one - while the field both " +
  "government matchers join on sat empty. The import screen now derives its destinations from the " +
  "field catalog (one source, where there were five hand-maintained copies), the writer stores what " +
  "the screen offers and REFUSES OUT LOUD a mapped field it cannot handle, an all-blank mapped column " +
  "is reported per column before import, and a blank cell lands as absent, never as an empty string. " +
  "One portal identity now belongs to at most one candidate, enforced by the database itself. And the " +
  "recovery is a screen, not a script: Candidates > Portal ID health shows what is wrong in six " +
  "honest groups - fixable ones with checkboxes (empty-string artefacts, IDs sitting in the wrong " +
  "field, attendance rows attachable by EXACT ID equality) and report-only ones the machine must not " +
  "touch (two people on one ID, disagreeing values, students with no ID anywhere). Every apply " +
  "re-verifies against the database at write time, never overwrites, and rows from an import bearing " +
  "the -154 shifted-column signature are held rather than attached. The portal ID also becomes " +
  "mandatory exactly where it is indispensable: certification cannot be marked complete while an " +
  "enrolled student has none - enrolment stays open, because a candidate legitimately exists here " +
  "before the government registers them. " +
  "-154 is one guard, shipped alone because the deadline sat outside the codebase: a re-upload of " +
  "the government attendance export was being arranged when the 20-08 file was measured, column " +
  "against column, and found SHIFTED - its days-attended figures sitting in the working-days field " +
  "(24 of 24 rows, days-present empty on every one) with hours in decimals where every genuine file " +
  "is HH:MM:SS. That file imported silently, its rows became the newest matched rows, and two " +
  "students who had genuinely cleared the 60-hour bar read as not eligible off figures the " +
  "government never asserted. Newest-import-wins is the right rule; a misread file wearing the " +
  "newest timestamp is how it lies. The import now recognises that signature at preview - " +
  "days-present empty on nearly every row WHILE working-days varies per student, both halves " +
  "required so a genuinely empty column or a two-batch file cannot trip it - names it in red while " +
  "the operator still has the file open, and holds the import button until an explicit tick. A " +
  "genuine export with one batch-level working-day figure imports exactly as before, which is the " +
  "pin that matters most. The rows the corrupt file already wrote are not repaired by code: " +
  "removing that import is a production data decision, prepared for Umesh, and the moment it is " +
  "removed the older correct rows become newest again by themselves. " +
  "-153 is the first two rows of Manish's 20 August list, and both are one shape: a screen stating " +
  "something false with complete confidence. QA-395 - a trainer at a centre running two batches was " +
  "shown a batch count of 2 and, on clicking through, one batch. Neither number was wrong; they were " +
  "answers to different questions. A Trainer login is scoped by LOCATION, so the dashboard counted " +
  "the centre, while the list it links to resolves the login to its own trainer record and defaults " +
  "to My batches. There is now one definition of which batches a login's Home is about, and every " +
  "figure on it reads that - the counts, the subtitles printed under them, attendance, enrolment and " +
  "the log queues. That breadth is the checker's doing: the first attempt moved the two counts and " +
  "left a centre figure in the subtitle directly beneath a headline newly labelled My, which is the " +
  "same defect one line lower, shipped by its own fix. QA-393 and QA-293 - the batch Attendance tab " +
  "told an operator the government export for two students had never been imported. It had been, " +
  "three times, their hours were stored, and the same sentence was correct about the other eight " +
  "members of that batch, which is what made it dangerous. Both students share a name, so the matcher " +
  "refused to guess between them - correctly - and the rows stayed unattached. Unattached is not " +
  "missing, so it now has its own verdict: the export carries these hours, the row is not linked to " +
  "this student yet, and here is the screen that links it. Where the hours column itself could not be " +
  "read the wording says that instead of claiming hours exist. The student's own page was a third " +
  "surface carrying the same false sentence and, after the first attempt, the only one still carrying " +
  "it; it now says a portal attendance record IN THEIR NAME is being matched to them, and quotes " +
  "no shortfall computed off our own logs while it waits - in words or in the progress bar, which " +
  "went on painting a figure from our own logs after every sentence around it had stopped. Saying " +
  "the portal had sent THEIR hours would have been a confident falsehood told to a student whose " +
  "registration is still pending, which is the reader least able to check it. The last correction " +
  "is the one worth naming: three surfaces were given the same LOOKUP and not the same GATE, so one " +
  "unattached row produced three different answers about one not-enrolled student. Eligibility is " +
  "gated on enrolment and always was; where a students hours are is a fact about data and is gated " +
  "on nothing. One helper decides it, the answer rides on the row, and every surface reads that one " +
  "field. A fourth surface - one summary line on the Closure tab - still counts these off the " +
  "gated verdict and under-reports them; it is recorded as QA-432 and fixed in its own unit rather " +
  "than in a hurried fourth pass at this one. Nothing here can qualify anybody - only a row the ERP " +
  "has actually attached to a person may move their hours. " +
  "-152 makes true a claim -150 had already made three times. QA-369: a comment correction was named " +
  "in that release's commit message, in its manifest and in its published note - and git says the " +
  "file was never touched. The cause is small and worth naming exactly: the edit went through a " +
  "plain string replace instead of the asserting helper used everywhere else, so when the anchor did " +
  "not match it did nothing, silently, and reported success. Every other edit in that release " +
  "asserted its anchor and every other edit landed. A claim that is not backed by the artifact is " +
  "the failure this pair exists to catch, and this time it was mine on three surfaces at once. The " +
  "comment now says where the safeguard actually lives, and the line number was measured rather than " +
  "remembered - the previous two attempts at it both quoted a line that had already moved. QA-370, " +
  "outside the app: the missing-row detector walked only from the lowest release number it could " +
  "see, so the FIRST releases of any new series were unprotected - a prefix whose rows start at 3 " +
  "has 1 and 2 missing and nothing said so. It walks from the start of a series now, with the " +
  "genesis prefix keeping its floor because those predate the discipline and are not owed a row. " +
  "-151 fixes a bug I put into product code and could not see, and it took a checker's " +
  "control-character sweep to find it. field-catalog.ts carried a literal NUL byte inside a fallback " +
  "- an escape written into the file as the raw byte it names, the fourth instance of that in one " +
  "session and the first outside a test harness. Two consequences, and the second is the ugly one. " +
  "The header normaliser strips it, so the guard was provably identical to falling back to an empty " +
  "string - and a role check of the form 'role includes empty string' is ALWAYS TRUE, so a programme " +
  "carrying no code would have matched EVERY job role and won the fuzzy pass. Latent only because " +
  "the code field is required today. And the byte made the whole file BINARY to git grep and " +
  "ripgrep, so the thing that broke it is the same thing that hid it from every search that might " +
  "have found it. An absent code now matches nothing, and a scan refuses any control character " +
  "anywhere in src or scripts - proved by putting a NUL back and watching it fail. QA-350: the " +
  "reason -149 gave for leaving trainer matching global was wrong, and the checker was right to " +
  "refuse that closure while accepting the diff - a trainer has FOUR possible links to a centre, not " +
  "one, which the Home scope union has always known. The search stays global as an OPEN question " +
  "rather than a settled one, because narrowing it is a behaviour change to live matching and -150 " +
  "just showed three of those four arms were themselves inert. QA-351 and QA-352, outside the app: " +
  "the commit guard could HANG on an unclosed stdin - and a hook that hangs blocks every command in " +
  "the session, which is worse than the silence it replaced - and it fired on ordinary git reads " +
  "because it matched the words rather than the subcommand. Both fixed and all three cases proved. " +
  "-150 carries a live scope defect that has been silently wrong for scoped centres, found by a " +
  "checker while it was testing something else. The Home trainer union matches a scoped user's " +
  "centres four ways - nomination, capability, home centre, and the batches they run - and three of " +
  "those four have never matched anything. requireUser hands the session its location_scope as " +
  "STRINGS, and Mongoose does no schema casting inside an aggregation pipeline, so comparing them to " +
  "stored ObjectIds silently found nothing; only the arm whose ids come back from Batch.distinct " +
  "survived, because those are real ObjectIds. Measured end to end: a Certified trainer whose " +
  "capable_locations IS the centre matched 1 with ObjectIds and 0 with strings, and Home returned " +
  "zero active trainers for that centre while the trainer existed. So a scoped centre has been " +
  "under-counting its own certified trainers. Same family as the scope leak two releases ago, except " +
  "the filter was not dropped - it was present, and matched nothing. QA-339: -148 stopped the WRITE " +
  "that stamped a student onto a trainer's attendance row and left the READ open, so the picker still " +
  "opened and offered four candidates on a row the product had just refused. Refusing at the write " +
  "while inviting at the read is the worse of the two states, because it spends an operator's " +
  "decision and then rejects it. Both doors refuse now. " +
  "-149 is three residuals from the last two verdicts, and the smallest one is the most interesting. " +
  "QA-334: the portal matcher loaded trainers with Trainer.find(scope.locationId ? {} : {}) - a " +
  "ternary whose two branches are the SAME empty filter, so it has always searched every trainer in " +
  "the database while LOOKING like it narrowed to the import's centre. That is QA-302's shape again, " +
  "a filter that pretends. It is removed rather than implemented, and the reason is measured rather " +
  "than assumed: a trainer's only link to a centre is nominated_for_location, and QA-280 counted 22 " +
  "of 23 live trainers carrying no nomination at all, so scoping on it would match almost nobody and " +
  "would break the trainer rows that match correctly today. The search is global on purpose now, and " +
  "says so. QA-324: this build's own copy scanner had grown from one check to several, and every " +
  "finding was still being summarised as 'user-facing string(s) still carry a Rule/DEC/QA code' - so " +
  "a scope leak was announced as a copy problem and the suggested fix was to rewrite a sentence. It " +
  "names what it actually found now. QA-326, outside the app: the commit guard read the manifests and " +
  "never looked at the working tree, which is why nothing objected when a release commit swept three " +
  "checker scratch files to production. It inspects the tree now - and fixing it uncovered that the " +
  "guard had been silent for every real commit this project has ever made, because its condition " +
  "required the words git and commit to be adjacent while every commit here is written git -C " +
  "<dir> commit. A gate that looks installed and never fires is the failure mode the whole " +
  "arrangement exists to prevent. " +
  "-148 closes a defect -146 created, and the wording was only the invitation. -146 widened the " +
  "read-time note to every unresolved import row and never constructed the case where that row is a " +
  "TRAINER. A portal export carries a centre's own trainers alongside its students, so a trainer the " +
  "ERP had never heard of - stored Unmatched - started reading 'this person IS in the ERP now, click " +
  "this row to link them' the moment anyone enrolled a candidate of the same name. The only control " +
  "that sentence can point at is the CANDIDATE picker. The checker then measured the rest: the API " +
  "ACCEPTED the link and stamped a student onto a trainer's attendance row. The existing refusal " +
  "tested row.trainer, which is set only when the importer already MATCHED a trainer record - so it " +
  "guarded every row except the one that needed it. -127 had already settled which test is right for " +
  "this exact question, for the assessment verdict: the EXPORT's own type column, because a trainer " +
  "the ERP has never heard of is still not a candidate. Both halves now use it. The row says what it " +
  "actually is, and the door refuses the write with a reason, before the body is read, so a bad call " +
  "cannot half-run. Pinned end to end: import an unknown trainer, enrol a candidate sharing the name, " +
  "require the note NOT to offer a link, require the API to answer 400, and require the row to be " +
  "byte-unchanged afterwards. " +
  "-147 exists because the checker FAILED -145 and was right to. That release fixed a live scope " +
  "leak correctly, and claimed both of its pins had been verified by breaking the source and " +
  "watching them fail. That was true of the source scan and FALSE of the end-to-end pin, which I " +
  "asserted rather than ran - in a manifest whose own text says a pin nobody has seen fail is a " +
  "comment. The checker ran it and it passed on the broken code. It was vacuous three ways over: it " +
  "compared our_roster, which is clamped by a Math.max; it carried a disjunct that is true precisely " +
  "in the scenario it was meant to catch; and above all the buggy aggregate only executes when the " +
  "user has a portal-covered batch, which no seeded role had - so the guarded branch was never " +
  "entered at all. The new pin BUILDS that state instead of hoping for it: it makes the scoped " +
  "user's own batch portal-covered, then asserts their own-log figure is zero, because their only " +
  "batch carrying logs is now the one the portal answers for. Measured both ways on real builds " +
  "before it was written - pre-fix the scoped role reads 26 against the organisation's 24, which is " +
  "a scoped user out-counting the whole company and is impossible with a scope applied; post-fix it " +
  "reads 0. QA-323, also from that verdict: two trainer KPIs on the same screen carried no scope at " +
  "all and were safe only because a role list in another file withholds them from scoped users - " +
  "protection living somewhere else, on a different mechanism, one edit away from shipping the " +
  "country's figure to a centre. They carry the scope themselves now. Writing that fix reproduced " +
  "QA-302's own bug MIRRORED, a key declared before a spread and silently replaced by it, so the " +
  "source scan now reads both sides of a spread instead of only what follows it. QA-322: the -145 " +
  "manifest said exactly two scope-spread sites exist; there are eighteen, and two was the count of " +
  "something else. Corrected rather than argued. " +
  "-146 closes the branch -143 deliberately left open, and it was the more embarrassing of the two. " +
  "An import row the ERP could not match keeps the sentence 'No candidate named X in this centre', " +
  "written onto it at import time - so once somebody actually enrols X, the screen goes on denying " +
  "the existence of a student who is sitting in the roster, until the file is imported again. That " +
  "is the exact order a centre works in: import the portal file first, enrol the missing student " +
  "second. -143 fixed only the Ambiguous branch and said so in its own notes rather than widening " +
  "the unit mid-flight; this widens the re-derivation to every unresolved row. It calls the same " +
  "matcher the importer calls rather than a second copy of the rules, and it takes only the NOTE: " +
  "the stored match status is never overwritten, because a read must not decide a match that a " +
  "human has not made. Where nothing has changed the note is simply re-issued with live counts and " +
  "current wording; where the world has moved the row now says what is true - that the person is in " +
  "the ERP now - and points at the control that links them, which is the row itself rather than the " +
  "candidate screen the older sentences sent people to. Pinned by importing a name nobody has, " +
  "confirming the row denies the student, enrolling that student, and requiring the same row to " +
  "stop denying them while staying unresolved. " +
  "Two more rows fold in here because the checker raised them against -144 while this same file was " +
  "open. QA-315: the fix for -144 stopped at the library boundary - the route added by -143 kept its " +
  "own weaker copy of the same expression, so the guard held inside the matcher and not twelve lines " +
  "up the stack. It is derived the same way on both sides now. QA-316 is the better finding and it " +
  "replaces a workaround with the real thing: matchGovtRows declared GovtRow[], where every field is " +
  "required and every string is a string, while the detail route has been feeding it lean documents " +
  "through an `as any` since -143 - so the type described a caller that no longer existed, and tsc " +
  "exited 0, under strict, on the exact bare read that takes the whole import view down. That is why " +
  "a regular expression over the source was standing in for the compiler. The signature is now " +
  "Partial<GovtRow>[], MatchedRow widens with it, the cast at the call site is gone, and re-introducing " +
  "the bare read is now a COMPILE error rather than a green build - which guards every field and every " +
  "method, not the five a scan remembered to look for. " +
  "-145 closes a live scope leak, and the way it hid is the point. Every scoped role's Home tile " +
  "counted the whole country's own-log attendance while every portal figure beside it was " +
  "correctly narrowed. Measured across three roles on -138: the Gurugram SPOC saw portal roster " +
  "1043 not 1447 and 2 batches not 4, all correct - and then our_present 35 / our_roster 180, " +
  "byte-identical to the Admin's. Their own two batches are both portal-covered, so the honest " +
  "figure for them is zero; the 180 they were shown belongs to another centre entirely. The cause " +
  "was not logic. The aggregate read { ...batchScope, batch: { $nin: [...] } }, and batchScope IS " +
  "{ batch: { $in: scopedBatchIds } } - so the object literal set the same key twice and its own " +
  "copy won, deleting the scope filter. Rule 38 and LANDMINE L4 both defeated by JavaScript rather " +
  "than by reasoning, which is exactly why it survived review: the line reads correctly. The tell " +
  "was twelve lines above it, where the neighbouring aggregate avoids the identical collision with " +
  "an explicit conditional. Both conditions are now built into one batch object that no sibling key " +
  "can overwrite. Pinned twice, because one of them would not have caught it: a source scan that " +
  "reads what each scope object actually defines and refuses any colliding sibling key anywhere in " +
  "the codebase, and an end-to-end check that compares a scoped role against the Admin at the same " +
  "instant - a leak makes those two halves identical while the portal half stays narrowed, which is " +
  "the fingerprint that was on screen. " +
  "-144, and the row it fixes was created by -143. The checker's adversarial pass on that release " +
  "found that matchGovtRows reads r.govt_candidate_id.trim() unguarded, and -143 is exactly what " +
  "made it matter: the function used to be fed only rows fresh off the parser, where the field is " +
  "always a string, and -143 began calling it from the import DETAIL route with PERSISTED " +
  "documents. A stored row without that key throws, and it throws in a loop that builds the whole " +
  "response - so the cost is a 500 on the entire import view, not one row's note. The checker was " +
  "careful to state the limit and the limit holds: no shipped path produces such a document, " +
  "because the parser's column reader returns an empty string for a missing column and never " +
  "undefined. So the guard is defence in depth. What earns the fix is that the tell was already " +
  "inside the same function - the identical expression was guarded 46 lines further down, and both " +
  "writers in the match route use String(... ?? \"\"). The value is therefore derived ONCE, guarded, " +
  "and reused at all four sites, rather than patching the single line that was reported and leaving " +
  "the inconsistency for the next reader. Pinned on the shape that IS reachable and is one step " +
  "short of it: a portal export carrying no Candidate ID COLUMN at all, which the header detector " +
  "accepts, whose rows then carry an empty id and are re-matched on every read of the detail. " +
  "-143, and both rows it closes are the same defect wearing two faces: a value worked out at " +
  "IMPORT time and stored answers the question as it stood on the day of the import, and keeps " +
  "answering it that way forever. QA-300, reopened as PARTIAL by the checker: -142 changed the " +
  "wording on the upload preview, which an operator sees once while committing a file. The same " +
  "number prints in two more places - the Variance column on the imports list, which is the " +
  "surface met first and every time and was still a bold amber count, and the detail filter chip, " +
  "which named a comparison that was never made. Neither could be fixed the same way, and the " +
  "reason is the interesting part: have_local_logs is not a field on the import schema, so " +
  "create() dropped it in strict mode and NO import has ever stored it. Both surfaces read " +
  "undefined forever, not only the ones that predate -142, and the grey branch was right on them " +
  "by accident. It is now derived from the rows at read time, on the list and on the detail, and " +
  "on the detail it is derived over the WHOLE import rather than the filtered rows, so the answer " +
  "cannot change with the chip you clicked. QA-298, reopened by the checker: -137 rewrote the " +
  "ambiguity note so two colliding rows could be told apart, and that wording really is in the " +
  "matcher - but match_note is written at import time and persisted on the row, so it reaches " +
  "FUTURE imports only. The two live rows that raised the complaint still read the old sentence, " +
  "character for character identical, pointing at a screen other than the one that resolves them. " +
  "The note is now re-derived on read by calling the same matcher the importer calls, never a " +
  "second copy of the rules, and only the note is taken from it - a row a human resolved through " +
  "the drawer stays resolved. Pinned by changing the world after the import: a third same-name " +
  "candidate must make the note say three, which a stored sentence cannot do. " +
  "-142, the last two rows of the 19 Aug recording, and the first of them turned out not to be a " +
  "bug. QA-297: the File line read 'Gurugram Batch 2 - final attendance.csv' while the Period label " +
  "beneath it read 'Guguram Batch 2 - Final Attendance' - a letter short and Title Cased, which is " +
  "what pointed at derivation. The row said plainly that the recording could not prove whether the " +
  "label was auto-filled or typed, and asked before spending an hour. MEASURED: it is TYPED. The " +
  "drawer's only writer is the operator's own input and the server falls back to the filename only " +
  "when it is left blank. So the misspelling was somebody's mistype, not a derivation bug - and what " +
  "was actually missing is any way to correct it, which is what Umesh asked for. The IMPORT stays " +
  "uneditable, because it is a point-in-time record of what the portal said; the NAME is ours, it is " +
  "how one import is told from the next in a list that already holds several, and it is now " +
  "renameable by anyone who can import, audited old-value-to-new. Pinned that nothing ELSE about the " +
  "import is reachable through that door. QA-300: '35 differ from our logs' printed in orange at a " +
  "centre whose batch header says 'Our logs: 0 days' and whose every candidate row reads 'OUR DAYS " +
  "0 / 0'. Technically true, practically meaningless - nothing was being compared, and the variance " +
  "column was the portal's own figure copied across with a plus sign. An alarming number that cannot " +
  "mean what it says is worse than no number, because it sends somebody looking for a discrepancy " +
  "that does not exist. The importer now reports whether there is any attendance of ours at all, and " +
  "the screen says 'no attendance of our own to compare against yet' instead. " +
  "-141, the Locations screen from the 19 Aug recording, in the order the rows themselves demand. " +
  "QA-295 FIRST, because it decides what QA-294 may sum: the summary line said '55 job-role rows' " +
  "twelve seconds above a table footer reading 'Showing 1-25 of 57', no filter touched between. BOTH " +
  "NUMBERS ARE RIGHT and they count different things - flatRows renders (l.job_roles?.length ? " +
  "l.job_roles : [null]), so a centre with NO job role still contributes one table row. 57 = 55 real " +
  "pairs + 2 centres carrying none. The arithmetic was never wrong; calling both of them 'rows' was. " +
  "They are named apart now, and the count of centres with no job role is stated rather than left to " +
  "be inferred from a gap. QA-294: 'sabke niche ek total chahiye, ye jahan-jahan numbers wale " +
  "columns hain' - a totals strip under the grid, over EVERY numeric column. It is handed the " +
  "FILTERED set rather than the visible page, because a total that covers 25 of 57 rows is worse " +
  "than none; filter or switch tab and it recomputes. The placeholder rows contribute nothing, which " +
  "is the QA-295 distinction turned into arithmetic - and it is why that row had to land first. ";

  "-140: the release note itself, for the third time, and this one is worth writing down. QA-265 " +
  "split the note in two so the UNAUTHENTICATED build marker publishes what THIS build changed " +
  "rather than the whole archive. I have now spliced the previous note into CURRENT on three " +
  "separate bumps. -128 and -129 were caught by reading the endpoint; the pin written after them " +
  "looked only for the archive's own opening and missed both. -139's pin looked for the previous " +
  "release's block but matched `\"-138 ` and `\"-138:` - and the block opened `\"-138,`. So the " +
  "marker published 4,512 characters covering three releases while a green pin said it was fine. " +
  "The pattern is the same one this project keeps paying for: a guard written to catch the exact " +
  "shape of the last mistake, which the next one steps around. The separator is now ANY character, " +
  "and I proved it by re-introducing the splice and watching the wall fail. Also -139's own subject, " +
  "restated because the note that shipped it was buried in the pile: the attendance denominator was " +
  "roster_count summed over DAILY LOGS, so a batch nobody logged contributed nothing to the bottom " +
  "of the fraction and a centre that recorded nothing scored the same as one with perfect " +
  "attendance. It divides by the days that should have happened now. ";

  "-139 (QA-292, the half -138 left open): the attendance DENOMINATOR. -138 fixed where the " +
  "numerator comes from - the portal, not only our own logs - and the checker's row was sharper than " +
  "the sheet on the other half: roster read 180 while 247 students are enrolled, and the right " +
  "figure was already in the same response, unused. THE CAUSE: roster was roster_count summed over " +
  "DAILY LOGS - only the days somebody happened to log. A batch nobody logged contributed nothing to " +
  "the BOTTOM of the fraction, so a centre that recorded nothing scored the same as one with perfect " +
  "attendance; the metric rewarded not writing anything down. 'Total Attendance' has to divide by " +
  "the days that SHOULD have happened, which is expectedDays - computed a few lines above and thrown " +
  "away. Portal-answered batches are excluded from it, because their student-days are already " +
  "counted from the export's own working-day figure and would otherwise sit in the denominator " +
  "twice. The subtitle now reports the same denominator the headline divides by, which it did not. ";

  "-138, the Home dashboard from the 19 Aug recording. G-07: the tile read 'Total Attendance 12%' " +
  "from 16 of 135 LOGGED student-days, at a centre whose batch page says 'Our logs: 0 days' and " +
  "which had just imported 38 students across 17 portal working days. Umesh's own account of why: " +
  "those cohorts ran BEFORE this ERP existed, so their attendance only ever went to the government " +
  "portal - 'attendance same hi hai, bas hum chah rahe hain ki ab hamare system me bhi data aane " +
  "lage.' THE TWO ARE NOT ADDED, and that is the design decision rather than an oversight: they " +
  "describe the SAME days, so summing them would double-count every day a diligent centre recorded " +
  "twice. Per batch the portal answers where an import exists and our own logs answer where it does " +
  "not - the same 'two meters, one truth' split the batch tab already shows. 'Today' stays our logs " +
  "only, because the portal export is cumulative and carries no per-day figure, so there is no " +
  "honest way to ask it what happened today. And the tile now SAYS what it counted instead of " +
  "leaving it to be inferred. G-08: 'Open Trainer Requests 0 / 0 fulfilled' and 'Pending Follow-ups " +
  "0' both read zero and neither was in use. Removed, not hidden - a hidden tile is dead code that " +
  "reads as a feature - and replaced with the two counts he asked for: trainers nominated to date, " +
  "and certified AND free to start. 'Free' is derived exactly as the trainers list derives it " +
  "(-129's availabilityTag: Certified and on no live batch), and a pin asserts the two screens " +
  "agree, because this is a number a manager quotes out loud. The breakdown rides in the subtitle, " +
  "which is what he asked for. G-11: the Ongoing and Completed tiles used each other's HEADLINE as " +
  "their own subtitle, so the pair carried one fact in four places; each has a real breakdown now. " +
  "-137, from the 19 Aug screen recording: two 'Sachin Kumar' rows, both past the 60-hour bar, both " +
  "dropped - 25 qualified shown where 27 qualify, and both reading '~0 / 60 hrs (est.)' on the batch " +
  "tab beside neighbours populated from the same import. THE SHEET'S SUGGESTED FIX WAS ALREADY THE " +
  "SHIPPED BEHAVIOUR: matchGovtRows tries the portal ID FIRST and falls back to name. The trap is " +
  "underneath it. The ID branch can only see candidates that already carry sidh_candidate_id, and " +
  "every automatic writer of that field refuses an ambiguous match - rightly, because an identity " +
  "field must never be written off a guess, and the wall asserts that refusal on purpose. So two " +
  "same-name candidates with no portal ID could NEVER self-heal: the same file re-imported went " +
  "Ambiguous again, every time, forever. A HUMAN CHOOSING IS NOT A GUESS, and that is the whole " +
  "difference. The resolve drawer already existed - the sheet's claim that no control exists is half " +
  "wrong - but it wrote the ROW and stopped. It now also stamps the portal ID onto the chosen " +
  "candidate, guarded exactly as the importer's own write-back is: only when the row carries an ID, " +
  "never over one the candidate already has, and audited against the candidate because it is " +
  "identity data. The count and the batch tab then follow on their own; neither needed a fix. Also " +
  "the message: two rows colliding on a name produced notes identical CHARACTER FOR CHARACTER, " +
  "because only the count and the word 'name' were interpolated while the row carried its portal ID " +
  "all along. Each note names its own row now, and the advice points at the control on that row " +
  "rather than at a drawer on another screen reached by search.";

  "-136 (QA-282, the triage -133 said was not finished): it is finished, and the honest answer is " +
  "SMALLER than the row feared. The scan took three versions and both earlier ones were wrong in " +
  "OPPOSITE directions. v1 required the setter to sit inside an onClick, found 2, and missed the one " +
  "example Umesh actually gave - attLinks is filled inside an async handler. v2 fixed that and then " +
  "over-reported, because it read a setter's argument with a regex that stops at the first ')': " +
  "setShowSources((s) => !s) came back as '(s', so three working toggles and an accordion looked " +
  "trapped. v3 balances the parentheses, and the count fell 19 -> 15 with nothing changed but the " +
  "measuring. A scan that misses the reported case proves nothing; one that invents four proves less " +
  "than nothing, because it turns a real complaint into noise. THE REMAINING 15 WERE READ, NOT " +
  "GUESSED, and none is a trapped panel: filter values on selects that go back to '' (fLoc x2, " +
  "sheet-watch source), a bare <a> (driveRoot), a ring className (selected), spans of text " +
  "(uploadNote, knobs, shortfallMsg), a value loaded from data rather than opened (invoice), a mode " +
  "flag read in an actions prop (legacy), form state and wizard steps (p/enrol, p/register, the tab " +
  "wizard) - and perCandidate, which is a DELIBERATE one-way switch: you do not un-start " +
  "per-candidate marking and go back to the legacy count. So of the 22 the corrected scan would have " +
  "flagged, THREE were real, and all three shipped in -133. The ceiling pin stays as a guard against " +
  "the next one rather than as a claim that 15 things are broken - proved by adding a trapped panel " +
  "and watching it fail at 16.";

  "-135 (QA-283, the half -134 left open and named as open): the 'Verified on SIDH' mark had a " +
  "field and two routes that accepted it, and no way for a human to click it - so it could be set " +
  "through the API and nowhere else, which is a capability rather than a feature. The control now " +
  "sits beside the SIDH actions that already exist, offered only on a candidate who HAS an open " +
  "eligibility question, and it asks for confirmation first because this is somebody asserting a " +
  "fact about a real student's paperwork. THE PART THAT MATTERS IS WHO GETS TO SAY WHO: the caller " +
  "may assert the FACT and never the provenance. sidh_docs_verified_by and _on are deliberately NOT " +
  "on either route's field whitelist, so a client cannot send them; the server stamps both from the " +
  "session inside beforeUpdate, which runs after pick() and before the assign, so they survive. A " +
  "mark whose 'who' the client can write is a field, not evidence. Clearing the mark clears the " +
  "signature too - an un-marked record must not keep a stale one. Pinned by attempting the forgery: " +
  "the test PATCHes a made-up user id and a 1999 date alongside the flag and asserts BOTH are " +
  "ignored.";

  "-134, both rows decided by Umesh rather than by me. QA-283: a student whose training is RUNNING " +
  "was still labelled 'Unverified - Education not recorded'. Eligibility is a question asked BEFORE " +
  "somebody joins - is this person allowed on a batch - and once they are ON one the enrolment has " +
  "answered it, so the chip was noise on every row of a live cohort. It stops at enrolment now. " +
  "'Not eligible' is NOT hidden: that is a live problem whenever it appears. The harder half is the " +
  "one Umesh named: for cohorts that ran before this ERP existed the documents were completed on the " +
  "government portal and CANNOT be re-marked here, so the label was not merely irrelevant, it was " +
  "unfixable by design. There is now a 'Verified on SIDH' mark that a PERSON sets, recorded with who " +
  "and when. Nothing derives it - 'the batch is running, so the documents must exist' is an " +
  "inference, and QA-085 is the rule that a thing we do not know stays unknown rather than becoming " +
  "a confident yes. On BOTH candidate doors, because a field the item route does not accept looks " +
  "saved and is gone on the next read. QA-284: -112 was right to collapse the readiness checklist " +
  "once a batch starts - it is a preparation record with nothing left to say - but NOTHING took its " +
  "place, so half the Overview of a running batch was empty white space on the screen whose whole " +
  "job is to answer 'what is happening with this batch'. The collapse was the fix; the hole was the " +
  "cost of it, and nobody looked at the screen afterwards. It now shows what the page already " +
  "computed and was not displaying - roster against target, days we logged, the portal's working " +
  "days, who is qualified - and carries the four actions Umesh named: attendance, daily log, roster, " +
  "certificates. They move between tabs that already exist; nothing is duplicated.";

  "-133. QA-286 first, because it is mine: -132's importer warning pushed a whole SENTENCE per row " +
  "with the trainer's NAME baked into it and then deduped with new Set() - and every row has a " +
  "different name, so every string was unique and the Set collapsed nothing. The dedup was real code " +
  "that could never fire, and the -132 manifest claimed it worked. One wrong spreadsheet column still " +
  "produced one paragraph per row: eight for the incident it was raised about, capped at 25. It now " +
  "groups by the (skill, near-match) PAIR - the thing that actually repeats - and carries the count " +
  "and the names alongside: '8 rows (A, B, C ...): skill X is the same words as Y'. The count is what " +
  "tells an operator this was a COLUMN rather than a typo. QA-282, Umesh 19/08: 'platform me aisi " +
  "bahut sari jagah hai, toh woh sab main kaise bataata rahoon?' - he is right that enumerating them " +
  "is not his job. His own example was exact: the attendance-links panel opened on a click and " +
  "setAttLinks(null) did not exist ANYWHERE in the file, so there was no close button because nothing " +
  "could clear the state. He asked for this on 15/08 and it was fixed for HealthBanner and " +
  "ShareLinkPanel; four days later the panels BESIDE them still had no way out - the sixth instance " +
  "of the shape this project keeps paying for. Three closed here: the attendance links, the feedback " +
  "links, and the created-login panel, which is the one that matters most because it shows a " +
  "TEMPORARY PASSWORD once and sat on screen until the operator navigated away. NINETEEN REMAIN and " +
  "the release does not pretend otherwise - each needs reading before it is called a defect or " +
  "ordinary layout, and that triage is the work. What ships is a CEILING pin so the count cannot go " +
  "up while it happens. The scan itself had to be corrected first: my first version required the " +
  "setter to sit inside an onClick and therefore missed attLinks, the one example he actually gave, " +
  "which is filled inside an async handler. A scan that misses the reported case proves nothing.";

  "-132 (QA-281): the trainer importer stored the skills column verbatim while THREE columns beside " +
  "it in the same for-loop each resolved against real records and reported what did not match - " +
  "pipeline_status through resolveStage, and both nomination fields through name lookups that push " +
  "onto stage_unmatched / centre_unmatched / role_unmatched. Only the job role was written without a " +
  "word said. That asymmetry has a measured cost: all eight trainers carrying 'Battery Repair System " +
  "Technician' were created at the SAME TIMESTAMP, 2026-08-17T08:04, so nobody typed them past a " +
  "suggestion box - one spreadsheet column was read once into nine Battery rows, eight one way and " +
  "one the other, and the correct spelling ended up on exactly ONE trainer. The importer now resolves " +
  "the column against the same recognised set the trainer form uses (the JobRole master UNION the " +
  "programmes' trainer_skill), and when a value does not match it NAMES THE NEAR MATCH: 'the same " +
  "words as the existing job role X in a different order'. Sorting the words is what catches a " +
  "re-ordering; a genuine misspelling still does not match and is reported as unknown WITHOUT " +
  "inventing a correction, because guessing at somebody's data is worse than saying we do not " +
  "recognise it. It warns and never blocks - that was -69's decision and -128 reaffirmed it, since a " +
  "picker over a master holding zero rows would refuse every real job role - but a warning that names " +
  "the row you meant is a different thing from one that says 'unrecognised', and it is the only " +
  "version that stops a second spelling being created. Warnings are deduped: one wrong column " +
  "produces the same sentence on every row it touched, and eight copies is noise.";

  "-131, both rows from the checker's retro sweep over the five bypassed releases. QA-277: enrol ONE " +
  "candidate over a batch's target and you are warned; enrol thirty and you were not. The warning " +
  "exists and is correct - addMemberChecked computes 'Roster is now 46 of target 45' and returns it " +
  "on the member - and the single-add door has always surfaced it. The bulk door populated its " +
  "warning field ONLY from the eligibility check, so the roster warning was computed on every row " +
  "and thrown away. That is the FOURTH instance of one shape in three days (QA-273 on this very " +
  "route, QA-274, QA-275): a fix correct on the door the row named and absent from the door beside " +
  "it. Both warnings are kept rather than one winning - over-target and not-eligible are different " +
  "facts about the same enrolment and an operator needs both. QA-278: a whole live batch, " +
  "BHA-ITI-RPLHSL-SPIT-01, reads 'No portal hours yet' for all 45 students - 28 of them because one " +
  "file's hours were written as decimals and were imported the day BEFORE -106 taught the parser to " +
  "read that shape. Shivam Yadav has 109.94 hours in the government's own file and the ERP says he " +
  "has none. The row concluded somebody must fetch the spreadsheet again, because the source file is " +
  "not retained. IT DOES NOT HAVE TO BE: GovtAttendanceRow stores total_hours_raw - the string " +
  "exactly as the portal wrote it - beside the parsed minutes, so those 28 rows are not missing " +
  "their data, they are carrying '26.6' and '73.99' in a column nobody re-read after the parser " +
  "learned the shape. scripts/reparse-govt-hours.mjs re-derives minutes from the stored raw values, " +
  "touching only the DERIVED column and never the portal's own record, leaving anything it still " +
  "cannot read as null and naming those rows (QA-085: a figure we do not understand must stay " +
  "unknown rather than become a confident zero). It carries a COPY of hhmmssToMinutes, which is " +
  "unavoidable - the real one imports @/models and no plain migration can reach it - so the copy is " +
  "guarded rather than hoped about: it self-tests against a fixed table and the wall runs that. " +
  "Proved by breaking it, twice: the first version of the table never exercised the 10,000-hour " +
  "sanity guard at all, and the pin stayed green while I broke it.";

  "-130: three doors the earlier sweeps missed, all found by the checker reading the DEPLOYED " +
  "source rather than the diff. QA-273: a walk-in could be enrolled one at a time but not in bulk. " +
  "-124 taught the single-add door that a candidate with NO centre adopts the batch's; the bulk " +
  "door was three files away and got neither half. Without the exemption String(undefined) never " +
  "equalled the batch id, so every walk-in was refused - and refused with 'belongs to another " +
  "centre', naming a centre the person does not have. Without the adoption even a SUCCESSFUL bulk " +
  "enrolment left the record unscoped, so the student sat on the roster invisible to the very centre " +
  "running their batch. Both halves fixed and both pinned, because fixing only the refusal would " +
  "have shipped the silent one. QA-274: the public trainer application built its phone as the LAST " +
  "TEN DIGITS of whatever was typed, so '99999999999999' became a valid ten-digit number - the exact " +
  "value -126 taught the candidate door to refuse with 400. It also carried its own email regex with " +
  "no TLD-length check. Both now use lib/validate, so an UNAUTHENTICATED door is no longer laxer " +
  "than the staff form behind it. QA-275: -126 put the nine Skill India fields on p/register and on " +
  "both internal routes and stopped there. p/enrol - the email/SMS-OTP walk-in link - is a different " +
  "link for the SAME job, so a student arriving through it was still chased later for exactly the " +
  "data those fields exist to stop chasing. All nine are on that form and in that route now, " +
  "explicitly listed rather than spread from the body, because it is an unauthenticated door. " +
  "THE PATTERN, which is the actual lesson: three times now a fix has been correct on the door the " +
  "row named and absent from the door beside it. -126 fixed one public intake of three. -124 fixed " +
  "one roster path of two. Each was verified against the door it named and passed. The checker's own " +
  "words on passing QA-261: 'I checked the door the row named and did not ask whether the product " +
  "had another one.' Every pin here is written on the QUESTION rather than the route.";

  "-129: the trainer data model, from Divya's 18/08 round. QA-268: the document type read 'CIPSA " +
  "Certificate'. CIPSA is not a credential - the trainer certification is CITS, Craft Instructor " +
  "Training Scheme - and the live row so labelled holds a file named CITS Certificate.pdf, which is " +
  "the product being corrected by the person using it. Renamed at the source, not papered over with " +
  "a label map, because this value is STORED: a display layer would leave the wrong string in the " +
  "database and in every export. That makes it a MIGRATION, and the second collection is the " +
  "expensive one: a Program whose mandatory_trainer_docs still said 'CIPSA Certificate' would demand " +
  "a document type the UI can no longer offer, and Rule T2 would refuse Documents Completed for that " +
  "programme's trainers FOREVER - a permanent stall out of a rename. scripts/migrate-cits-doctype.mjs " +
  "moves both collections, names the programmes that would have stalled and the files it touches, " +
  "refuses rather than merges if any trainer somehow holds both names, and is idempotent. QA-270: " +
  "'Home location' offered CENTRES, so it could not hold what its own name promises - and the centre " +
  "a trainer works at was already recorded, just below, as 'Can train at'. -125 had fixed only the " +
  "list COLUMN, making 'Basti - no centre here' readable without touching the control that produced " +
  "it. It is a town now, and an EVOLVING one per Umesh: the options are the home towns already " +
  "recorded, so typing a new one offers it to the next person and the master builds itself. No new " +
  "collection and no new endpoint - the page already fetches every trainer. What it deliberately " +
  "does NOT do is rewrite the 4 trainers whose home is still a centre reference: blank keeps what is " +
  "there, typing replaces it, and quietly converting somebody's record on an unrelated save is data " +
  "loss with a nice name. QA-269: the tabs read 'Certified 0' while trainers showed a green " +
  "Certified chip. Both were right - the tab is a TODAY-state (certified AND on no live batch), the " +
  "chip is the stored stage - but one word meaning two numbers on one screen is a contradiction to " +
  "anyone scanning it, and 'Certified 0' is the figure a manager quotes out loud. The LABEL now says " +
  "what the tab counts ('Free to assign'); the VALUE is untouched because it rides in the URL and " +
  "saved links must keep working, the same split -102 used for Closing/'Result Awaited'. QA-271: the " +
  "centre picker carried a selectable placeholder, 'yet to be identify'. Location was the ONE master " +
  "with no way to retire a row - Program, Room, Trainer, Scheme and JobRole all carry an active flag " +
  "and their pickers honour it, but the offerable() helper had only ever been handed programmes. " +
  "Location has the flag now, on BOTH routes (a field the item route does not accept looks saved and " +
  "is gone on the next read - the -116 lesson), and nine CREATION pickers filter through it while " +
  "the two list FILTERS and the centre switcher deliberately do not: you must still be able to look " +
  "at a retired centre's history and keep working on batches that live there. offerable() itself " +
  "existed three times, copy-pasted, each copy handed only programmes and one of them quietly " +
  "array-aware; there is one now, in lib/client, taking a scalar or an array. Retiring the junk row " +
  "and fixing the 'Govt ITI, Dudhi Sonbhadra' spelling are production data writes, prepared for " +
  "Umesh rather than run from here.";

  "-128 (QA-266, Divya 18/08): \"Move... ye move nahi ho raha hai\". Moving a trainer past " +
  "Shortlisted reported 'Saving...', reverted half a second later, saved nothing and said nothing. " +
  "NOTHING WAS SWALLOWED: the route answered 409 with a perfectly readable refusal, the page caught " +
  "it and called setErr - and rendered it in the PAGE-level banner, which the drawer's own " +
  "fixed inset-0 z-50 scrim paints straight over. A message the user cannot see is the same as no " +
  "message. And it was never one screen's bug: every drawer in this app piped its failures to a " +
  "page banner - 32 drawers across 11 files, including tabs and sub-drawers that are handed the " +
  "page's setError as a prop and so report UP into the thing covering them. Drawer has an error " +
  "slot now and all 32 pass it, the value travels beside the setter wherever setError was threaded, " +
  "and a wall pin fails if a drawer is ever added without one. Two more things the same screen was " +
  "getting wrong. The Move drawer never cleared the previous message before firing, which is why " +
  "the refusal read as an error that was already there rather than an answer to this click. And it " +
  "only REPORTED the one refusal it could have PREDICTED: Documents Completed needs a nomination, " +
  "which the page already knows, so the drawer now says so before the round trip and offers the " +
  "Set nomination control that fixes it - the control was on the same page all along, behind the " +
  "drawer's own scrim. QA-272: the refusal Divya photographed read 'Rule T3: say which centre and " +
  "job role...'. -111 built plain() precisely so nobody reads 'Rule 45' - but every pattern in it, " +
  "and in all three wall detectors, demanded a DIGIT after the prefix. The trainer pipeline numbers " +
  "its rules T2..T8, a letter then a digit, so seven refusals sailed through and the wall was blind " +
  "for the identical reason. Widened to T?, which then exposed two the strippers could never have " +
  "saved: a message with the code mid-sentence, and one written directly into JSX, where plain() " +
  "has no reach at all. QA-267: the amber 'this trainer will not appear on the Preparation board' " +
  "warning is a LIE THE PRODUCT TELLS ABOUT ITSELF. Checked every reader before touching it - the " +
  "Preparation board, Open Positions, the location role counts and the batch trainer dropdown all " +
  "key off nominated_for_location + nominated_for_program; the word skills appears in no query, " +
  "aggregation or filter anywhere in src/lib or src/app/api. The string matching was removed in " +
  "QA-133/134 on 15/08, deliberately, because an exact match had hidden a certified trainer over a " +
  "two-word difference - and this warning was never retired. So the transposed job-role string is " +
  "NOT why those trainers are missing; an unset nomination is, which is the same blank that refuses " +
  "the Move. The warning says what is true of the field and no more. No picker was built: the " +
  "job-roles master holds ZERO rows (QA-143), so a picker would offer four options and block every " +
  "real job role - that is data entry, not a build.";

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
  "the bug at all - the pin had to be moved onto the production shape first. QA-265, found while " +
  "writing this very note: see the comment above - the note itself was truncated to one line. " +
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
