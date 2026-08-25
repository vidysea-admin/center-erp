// QA-021 (-68): the candidate journey derivation, extracted CLIENT-SAFE so the candidates
// page and the new drop verb read the SAME stages — the drop has to stamp "Dropped (at X)"
// with the stage the server derives, never one the client claims. Third time this dual-copy
// class has been killed (QA-133 trainer predicate, QA-138 slot rule); the logic moved
// verbatim from candidates/page.tsx.

export type JourneyInput = {
  lifecycle_status?: string | null;
  enrolled_at?: unknown;
  sidh_status?: string | null;
  latest_result?: string | null;
  active_batch_status?: string | null;
  // QA-945 (2026-08-24): "Current" or "Future". Optional because every record written before this
  // field existed has none, and absent must read as Current — the overwhelmingly common case, and
  // the one that keeps existing candidates enrollable exactly as they were.
  batch_interest?: string | null;
};

export const FRESH_TAGS = ["Fresh Lead", "Portal Link Sent", "Registered on Portal", "Dropped"];

// QA-945 (2026-08-24, Umesh): "team ko ye help kregi ki future interested walo se jitna abhi data
// possible hai vo le legi aur baad mai dobara call kreke convert kr skti hai jo ki possible quality
// lead hogi future ki."
//
// This is deliberately NOT a value in the FRESH_TAGS ladder above. That ladder is a sequence of
// mutually exclusive STAGES a person moves along (lead -> link sent -> registered), and where they
// have reached is a different question from whether they want THIS intake. A future-interested
// candidate can perfectly well already be registered on the portal - that is precisely the "quality
// lead" Umesh is describing - and folding the two into one list would have forced a choice between
// showing their stage and showing their availability. So it rides ALONGSIDE, the way "No programme"
// and "Multi-interest" already do.
// 2026-08-25 (client call, confirmed by Umesh: "current / upcoming ---> current krr do and future
// wale ko upcomming - just text update krne hai hrr jagah bss"): the client renamed the two choices
// to "The current batch" and "Upcoming batch", and asked for that wording EVERYWHERE, not only in
// the dropdown - so this tag, the enrolment refusal and the import label all say it too.
// SCREEN WORD ONLY. The stored value stays "Future": it is live data on real candidate records, and
// changing an enum value is the add->migrate->remove dance of LANDMINE 1, not a text edit. So every
// screen says "Upcoming batch" while the database says "Future", and THIS constant is where the two
// meet - which is why the mapping is written down here rather than left to be rediscovered.
export const FUTURE_INTEREST_TAG = "Upcoming batch";

/** The gate in rules.ts `addMemberChecked` refuses exactly this. Absent = Current, by design. */
export function isFutureInterest(r: JourneyInput): boolean {
  return r.batch_interest === "Future";
}

// QA-1191 (2026-08-25). The Excel import wrote this field as RAW SHEET TEXT and never coerced it,
// unlike `education` and `sidh_status` sitting either side of it in the same loop. MEASURED on the
// live -247 build, not argued: a three-row sheet whose middle cell said "Upcoming batch" returned
// preview 200 (silence, on the very screen that exists to report unreadable values), then confirm
// 400 `batch_interest must be one of: Current, Future` - and ZERO of the three rows landed. A valid
// value in the same position imported 3 of 3. So one cell killed the whole file.
//
// And QA-1190 sharpened the bait rather than causing it: the import screen's own label now reads
// "Interested in (Current / Upcoming batch)", so "Upcoming batch" is precisely the phrase the screen
// invites an operator to type - and the refusal then lists the STORED values back at them, which are
// words that appear nowhere on their screen.
//
// IT LIVES HERE, beside FUTURE_INTEREST_TAG, because this file is already the one place where the
// screen's vocabulary and the stored values meet. A second copy in the import route is how
// ARCHITECTURE section 3 says this codebase breaks.
//
// TIGHT LIST, AND REPORT THE REST - never guess. The two failure directions are not symmetric: a
// wrong "Future" silently BLOCKS a real person from every batch until somebody notices, while an
// unrecognised cell simply goes unset, takes the schema default of "Current", and leaves them
// enrollable exactly as before. So anything not spelled out below is REPORTED, the posture the
// route's own comment already states for sidh_status: "an unrecognised value is REPORTED, never
// guessed at".
// QA-1236 (checker, qa-1191 cycle 1): DERIVED from FUTURE_INTEREST_TAG, not re-spelled beside it.
// Cycle 1 hand-typed "upcoming batch" one line under the constant that already holds those exact
// words - one day after a client renamed them. The next rename would move the tag and leave this
// list behind, and the failure would be silent: a sheet saying what the screen says would stop
// being understood, with nothing red anywhere.
const FUT = FUTURE_INTEREST_TAG.toLowerCase();
const BATCH_INTEREST_WORDS: Record<string, "Current" | "Future"> = {
  "current": "Current", "current batch": "Current", "the current batch": "Current",
  "future": "Future", "upcoming": "Future", "future batch": "Future", "a future batch": "Future",
  [FUT]: "Future",          // whatever the tag says today - "upcoming batch"
  [`the ${FUT}`]: "Future",
};

/** Sheet cell -> stored value, or null when it is not one we recognise (caller REPORTS it). */
export function coerceBatchInterest(raw: unknown): "Current" | "Future" | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return s ? (BATCH_INTEREST_WORDS[s] ?? null) : null;
}
export const JOURNEY_TAGS = ["Enrollment in progress", "Training Ongoing", "Training Completed", "Result Awaited", "Certified", "Dropout", "Failed", "Absent at Assessment"];

// Fresh bucket = never completed an enrollment (a roster drop BEFORE enrollment counts as Fresh).
export function isFreshCandidate(r: JourneyInput): boolean {
  const ls = r.lifecycle_status ?? "Unassigned";
  return ["Unassigned", "Dropped"].includes(ls) && !(ls === "Dropped" && r.enrolled_at);
}

export function freshJourneyOf(r: JourneyInput): string {
  if (r.lifecycle_status === "Dropped") return "Dropped";
  if (r.sidh_status === "Registered") return "Registered on Portal";
  if (r.sidh_status === "Link Sent") return "Portal Link Sent";
  return "Fresh Lead";
}

export function journeyOf(r: JourneyInput): string {
  if (r.lifecycle_status === "Dropped") return "Dropout"; // enrolled-then-left (CEO 14/08)
  if (r.latest_result === "Pass" || r.lifecycle_status === "Completed") return "Certified";
  if (r.latest_result === "Fail" || r.lifecycle_status === "Failed") return "Failed";
  if (r.latest_result === "Absent") return "Absent at Assessment";
  if (r.lifecycle_status === "Assigned") return "Enrollment in progress";
  const bs = r.active_batch_status;
  if (bs === "Closing") return "Training Completed";
  if (bs === "Completed") return "Result Awaited";
  return "Training Ongoing";
}

// The stage a drop is recorded AT — whichever bucket the person is in right now.
export function currentStageOf(r: JourneyInput): string {
  return isFreshCandidate(r) ? freshJourneyOf(r) : journeyOf(r);
}

// QA-1198 (DRY roadmap D6, 2026-08-25): "is this certificate SETTLED" had FOUR spellings of the
// same literal — rules.ts's certification-completeness gate, the certificate upload route, the
// complete-batch preview, and the batch screen's "Passed, no certificate" filter. It lives here
// because this module imports NOTHING and is already read by a client page, a route and rules.ts,
// so it is the one place all four callers can reach (ARCHITECTURE 3.7's wall: @/models pulls
// mongoose, so the client screen could never import CERTIFICATE_STATUS).
//
// "Not Issued" is a SETTLED outcome, not an outstanding one — a decision was taken and recorded.
// That is the whole content of the predicate and the reason a bare `=== "Issued"` is wrong
// everywhere. A subset of models CERTIFICATE_STATUS by design; not a copy of it.
export const SETTLED_CERTIFICATE_STATUSES = ["Issued", "Not Issued"];

/** True when a certificate outcome has been decided — issued OR deliberately not issued. */
export function isCertificateSettled(status?: string | null): boolean {
  return SETTLED_CERTIFICATE_STATUSES.includes(String(status ?? ""));
}

// ---------------------------------------------------------------------------
// "Has this member LEFT the batch, and where are they still allowed to appear?"
// ---------------------------------------------------------------------------
//
// 2026-08-25 (Umesh, on candidate Ashish Rana / CAN_14318483, batch AVP-GURU-RPLAVP-DST-03 —
// dropped 25 Aug with reason "Not interested"):
//
//     "log rakho candidate wale mai but baaki jagah se tho data naa dikhee.
//      aur jagah se remove ho jaaye uske traces."
//
// Asked to state the rule in one line, he chose these words, and `showsAfterLeaving` below IS
// that sentence in code:
//
//     A left member appears only where they have a record of their own;
//     where they are just a name, they are gone.
//
// WHY THESE LIVE HERE, AND WHY THEY EXIST AT ALL.
// `BatchMember.left_on` (models/index.ts) is the only marker and `dropMemberChecked` (rules.ts)
// the only writer, but the QUESTION "is this one gone" had no shared name anywhere - so grepping
// for it found nothing and ARCHITECTURE 3 never listed it. A census of the BEHAVIOUR found six
// hand-written client copies inside batches/[id]/page.tsx alone, ~20 inline `left_on: null` Mongo
// literals on the server, two server helpers (`rosterOnDate`, `activeRoster`) - and zero
// client-safe predicate. That is ARCHITECTURE 3.0c's lesson landing again: searching for a NAME
// is not a census.
//
// Same home and same reason as `isCertificateSettled` above: this module imports NOTHING, so a
// "use client" screen can reach it while rules.ts (which pulls mongoose) can not be reached back.
// The ~20 server query literals are deliberately NOT collapsed here - those are Mongo query
// fragments, not a predicate, and re-pointing nine routes is its own unit.
//
// The defect class this closes is not "a screen showed one extra row". It is that every surface
// answered this question differently and each answer was defensible on its own: the attendance
// buckets filtered departed members while the chip above them counted the whole roster (QA-1157),
// one screen gave three different totals for "unmarked" and the bulk action silently used the
// smallest (QA-1158), and the closure card offered live Pass/Fail buttons beside a tooltip
// promising that "a member who has left cannot be marked". One predicate, read by all of them.

/** True when this batch member has left the batch — `left_on` is set. */
export function hasLeft(m: { left_on?: unknown } | null | undefined): boolean {
  return !!(m && m.left_on);
}

/** The members still on the batch. The client-side twin of rules.ts `activeRoster`. */
export function activeOnly<T extends { left_on?: unknown }>(xs: T[] | null | undefined): T[] {
  return (xs ?? []).filter((x) => !hasLeft(x));
}

// "Pending" is NOT a record. It is the absence of one — the row exists because somebody opened the
// screen, not because anybody decided anything. Treating it as a record would keep exactly the
// cards Umesh asked to disappear, since an unmarked departed member is the common case.
/** True when a final assessment result has actually been decided for this row. */
export function hasRecordedResult(r: { result?: string | null } | null | undefined): boolean {
  const v = String(r?.result ?? "").trim();
  return !!v && v !== "Pending";
}

// The rule itself. `ownRecord` is whatever "a record of their own" means ON THAT SURFACE, and it
// differs on purpose — a decided result on the closure cards and the certificate picker, a
// submitted feedback row on the feedback tab, nothing at all on the attendance table (a departed
// member has no record of their own there, which is why they vanish from it entirely).
//
// Two surfaces deliberately do NOT call this and must not be "harmonised" into it:
//   - the batch Candidates/roster tab, which shows every member always with the leave date and
//     reason — it IS the log, and preserving it is the whole point of the rule;
//   - the government-attendance row-match dropdown, which shows departed candidates always,
//     labelled, because the portal export carries their pre-departure days and hiding them would
//     strand those rows unresolvable forever (QA-1041, QA-1067).
/** Umesh's rule: a departed member renders only where a record of their own exists. */
export function showsAfterLeaving(m: { left_on?: unknown } | null | undefined, ownRecord: boolean): boolean {
  return !hasLeft(m) || ownRecord;
}
