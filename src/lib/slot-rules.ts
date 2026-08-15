// QA-138 (15/08): the slot guideline check, extracted CLIENT-SAFE so the batch form can show
// the same errors while the operator types instead of springing them on Create. Moved verbatim
// from rules.ts — that file imports mongoose/models, so a page could never import it, and a
// hand-copied client version would drift (the exact failure QA-133's duplicated predicate had).
// rules.ts re-exports assertSlotWithinGuidelines on top of this; there is ONE rule, two callers.

const toMin = (hhmm: string) => {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(hhmm ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Scheme timing guidelines. 2026-08-12 (Manish): the training day runs 09:00–18:00 — a 07:00
 * start was asked for and refused; no minimum break is prescribed, so none is enforced.
 * 2026-08-13 (Manish, walkthrough): a session is EXACTLY 4 hours or EXACTLY 8 hours — "ya toh
 * 4 ghante ka rakho ya 8 ghante ka… aise aap beech ka tod-mod nahi kar sakte" (a 5-hour slot
 * was asked about and refused). This supersedes the earlier ≤4h ceiling: max_session_hours is
 * no longer consulted here. The day window stays in Defaults (a circular can move it without a
 * deploy); the 4/8 pair is the scheme's own constant, so it is code, not a knob.
 * Blocking (not warning) on the API is deliberate: these are the guidelines an audit checks.
 */
// QA-070 (-70): hours-per-day from the batch's slot, moved here CLIENT-SAFE for the same
// reason as the guideline check above — the Daily Execution summary carried its own
// hours/duration_days-or-8 copy (the exact assumed-8 QA-085 removed elsewhere). Unknown
// slot returns null: callers show nothing rather than assume.
export function slotHoursPerDay(batch: any): number | null {
  const slotMin = (toMin(String(batch?.slot_end ?? "")) ?? 0) - (toMin(String(batch?.slot_start ?? "")) ?? 0);
  return slotMin > 0 ? slotMin / 60 : null;
}

export function slotGuidelineErrors(
  slot: { slot_start?: string | null; slot_end?: string | null } | undefined,
  defaults: { day_start_time?: string; day_end_time?: string; max_session_hours?: number },
): string[] {
  if (!slot?.slot_start || !slot?.slot_end) return []; // slots stay optional — legacy batches have none
  const errs: string[] = [];
  const s = toMin(slot.slot_start), e = toMin(slot.slot_end);
  if (s == null || e == null) return ["Time slot must be in HH:mm form, e.g. 09:00."];
  if (e <= s) return ["Slot end must be after slot start."];

  const dayStart = toMin(defaults.day_start_time ?? "09:00") ?? 540;
  const dayEnd = toMin(defaults.day_end_time ?? "18:00") ?? 1080;
  if (s < dayStart || e > dayEnd) {
    errs.push(`Scheme guideline: training runs ${defaults.day_start_time ?? "09:00"}–${defaults.day_end_time ?? "18:00"}. This slot (${slot.slot_start}–${slot.slot_end}) falls outside it.`);
  }
  const durMin = e - s;
  if (durMin !== 240 && durMin !== 480) {
    errs.push(`Scheme guideline: a session is exactly 4 hours or exactly 8 hours. This slot is ${(durMin / 60).toFixed(1)} hours.`);
  }
  return errs;
}
