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
