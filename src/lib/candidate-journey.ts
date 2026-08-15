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
};

export const FRESH_TAGS = ["Fresh Lead", "Portal Link Sent", "Registered on Portal", "Dropped"];
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
