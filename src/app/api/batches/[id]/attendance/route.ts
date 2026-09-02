import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { ELIGIBILITY_STATES, assertBatchInScope, batchAttendanceRows } from "@/lib/rules";

// R-D (CEO 14/08): the batch's own "Attendance" tab — day-wise per student, BOTH meters
// side by side ("one is the attendance which they are taking, and second attendance from
// the government portal … number of days AND number of hours"), and the green verdict:
// once a student's hours cross the programme threshold they have "qualified for
// assessments". Readable by every role that can see the batch — the CEO wants the green
// mark "in all other logins also", so there is no extra permission gate here.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38 — scope is the only gate

  // A-09: this whole computation now lives in ONE place - `batchAttendanceRows` in lib/rules.ts -
  // because the door that decides a Pass has to be able to ask the same question this screen answers.
  // It could not before: the eight inputs behind a verdict were assembled inline here, in the route,
  // so writing a guard meant assembling them a second time somewhere else. The output of this
  // endpoint is unchanged; it reads the shared derivation instead of owning it.
  const { batch, days, rows, requiredHours, minPct, minPctSource, hoursPerDay, portalWorkingDays, finished, unresolvedPortalRows, unresolvedCentreRows } =
    await batchAttendanceRows(id);

  return NextResponse.json({
    days,
    days_held: days.length,
    members: rows,
    program_hours: batch.program?.hours || (batch.program?.duration_days ?? 15) * 8,
    // -251 (voice note 26-Aug): the sheet's "Total Training Days (QP)" denominator for the
    // Days Attendance % column below — program_hours above already covers the hours half.
    program_days: batch.program?.duration_days ?? null,
    min_attendance_pct: minPct,
    min_attendance_source: minPctSource, // "scheme" once the master carries hours, else "defaults"
    required_hours: requiredHours,
    hours_per_day: hoursPerDay,
    qualified_count: rows.filter((r) => r.qualified && !r.left_on).length,
    // -109: the honest breakdown, so a screen can say "23 qualified, 12 still short, 10 with no
    // hours on record, 0 genuinely not eligible" instead of lumping the last three together.
    course_finished: finished,
    portal_working_days: portalWorkingDays || null,
    // -153 cycle 2 (QA-413): this was a hand-typed list, and awaiting_match had to be remembered
    // into it or the -109 invariant (the buckets partition the roster) would have broken silently
    // the first time a row went unresolved. It reads the one exported state list now, so the union
    // and the buckets cannot drift apart. ("trainer" is constructed by the govt-attendance grid,
    // never returned here, so its bucket is a constant 0 on this route - present and honest.)
    // -156 (QA-432): the count the Closure line needs, and it is NOT verdict_counts.awaiting_match.
    // That bucket is journey-gated (a not-enrolled member is not_enrolled, never awaiting_match),
    // while every chip on this page reads the ungated ROW field - so the line under-reported and
    // three surfaces disagreed with it. Counting the rows is the fix; widening the bucket would
    // break the -109 partition, which is the one thing that must not move.
    awaiting_match_rows: rows.filter((r) => !r.left_on && r.awaiting_match).length,
    // QA-1763: the count the batch Overview must show beside "qualified for assessment", and it is
    // deliberately NOT awaiting_match_rows above. That one is member-gated and read 2 on Bhadohi
    // while the import screen read 3, because one portal row matched no roster member at all and so
    // sat in no member row. A client compared the uncaveated 13 against SIDH's 16 and filed it as a
    // defect; 13 + 3 = 16 and nothing was ever wrong but the sentence.
    unresolved_portal_rows: unresolvedPortalRows,
    // QA-1776: the other half of the same honesty. The line above counts rows filed against THIS
    // batch; this one counts rows filed against the CENTRE under no batch at all, matching nobody on
    // this roster. They are disjoint (batch: id versus batch: null) and they are two numbers rather
    // than one sum because they answer two questions, and REQ-418 is about exactly that.
    unresolved_portal_rows_centre: unresolvedCentreRows,
    // A-04 / A-05 (24-Aug issues sheet). The buckets below partition the ACTIVE roster, because
    // every one of them filters `!r.left_on` - and that is deliberate and stays. What was missing is
    // the other half of the arithmetic: the screen's own chip counts the WHOLE roster, so on a batch
    // where somebody has left, the buckets summed to one less than the tab beside them said and
    // there was no bucket for the reader to put that person in.
    // Live -244, BHA-ITI-RPLHSL-SPIT-01: '23 qualified - 17 with no portal hours imported - 5 not
    // eligible' = 45, printed on a screen whose chip read 'All 46'. Exactly one member had left.
    // (The report guessed the missing person was the one candidate with no portal ID. That batch has
    // exactly one of those too - two unrelated 1s. It is the departed member.)
    // These two numbers let every surface state the whole roster without widening the buckets, which
    // the -109 partition invariant above forbids.
    roster_count: rows.length,
    left_count: rows.filter((r) => r.left_on).length,
    verdict_counts: ELIGIBILITY_STATES.reduce((acc: Record<string, number>, k) => {
      acc[k] = rows.filter((r) => !r.left_on && r.verdict.state === k).length;
      return acc;
    }, {}),
  });
});
