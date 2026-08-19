import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError } from "@/lib/authz";
import { requirePerm, requireView } from "@/lib/permissions";
import { Batch, GovtAttendanceImport, GovtAttendanceRow } from "@/models";
import { assessmentHoursBar, courseIsFinished, eligibilityVerdict, memberAttendedHours } from "@/lib/rules";
import { isTrainerRow, matchGovtRows } from "@/lib/govt-attendance";
import { getDefaults } from "@/lib/defaults";
import { audit } from "@/lib/audit";

async function loadInScope(id: string, user: Awaited<ReturnType<typeof requireUser>>) {
  const imp = await GovtAttendanceImport.findById(id)
    .populate("location", "name external_id").populate("batch", "code")
    .populate("imported_by", "name").lean<any>();
  if (!imp) throw new HttpError(404, "Import not found");
  // QA-125 sweep (15/08): fail CLOSED like costs/[id] — a centre-less import is not
  // scoped-readable/deletable; before this, `imp.location &&` silently let it through.
  if (isScoped(user) && (!imp.location || !(user.location_scope ?? []).map(String).includes(String(imp.location._id)))) {
    throw new HttpError(403, "That import belongs to a centre outside your assigned locations.");
  }
  return imp;
}

export const GET = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "attendance.govt") /* QA-025 P3: read = view */;
  const { id } = await ctx.params;
  const imp = await loadInScope(id, user);
  // QA-023 (checker): every count on the summary is a question — each one answers as
  // its own filter. matched | ambiguous | unmatched | variance.
  const filter = req.nextUrl.searchParams.get("filter");
  const q: Record<string, unknown> = { import: id };
  if (filter === "variance") q.variance_days = { $nin: [0, null] };
  if (filter === "unmatched") q.match_status = { $in: ["Unmatched", "Ambiguous"] };
  if (filter === "matched") q.match_status = "Matched";
  if (filter === "ambiguous") q.match_status = "Ambiguous";
  const rows = await GovtAttendanceRow.find(q)
    .populate("candidate", "name phone").populate("trainer", "name").populate("batch", "code")
    .sort({ sl_no: 1 }).lean<any[]>();

  // -102, Manish 17/08 ([10:35]–[11:51] "wo ek status dala tha na… qualified, qualified — wo gaya
  // kaha… isme status wala column miss ho gaya… bas ek status chahiye ki ye qualified ho gaye.
  // Qualify ka rule yahi hai ki 60 plus hours"): right after an import, this grid is where he
  // stands, and it showed days and hours but never the verdict those hours produce. The verdict
  // itself already existed on the batch Attendance tab and is NOT re-derived here — the bar comes
  // from assessmentHoursBar and the answer from memberAttendedHours, the same two functions, so
  // the two screens can never drift apart (the QA-045 lesson).
  const defaults = await getDefaults();
  const batchIds = [...new Set([imp.batch?._id, ...rows.map((r) => r.batch?._id ?? r.batch)].filter(Boolean).map(String))];
  const batches = batchIds.length
    ? await Batch.find({ _id: { $in: batchIds } }).populate("program", "hours duration_days scheme").select("program status").lean<any[]>()
    : [];
  const batchById = new Map(batches.map((b) => [String(b._id), b]));
  const bars = new Map<string, { required_hours: number; min_pct: number; source: string }>();
  for (const b of batches) {
    const bar = await assessmentHoursBar(b.program?.scheme, b.program, defaults.min_attendance_pct ?? 50);
    bars.set(String(b._id), { required_hours: bar.requiredHours, min_pct: bar.minPct, source: bar.source });
  }
  // -143 (QA-298, checker REOPENED at -141): -137 rewrote the ambiguity note so two colliding
  // rows could be told apart, and the new wording IS in govt-attendance.ts - but match_note is
  // written by matchGovtRows at IMPORT time and persisted on the row, so it reaches future imports
  // only. The two live Sachin Kumar rows that produced the complaint still read, character for
  // character, "2 candidates share this name - set the portal Candidate ID on the right record to
  // resolve." - the old sentence, still identical, still pointing at another screen.
  //
  // Re-derived here by calling the SAME matchGovtRows the importer calls, never a second copy of
  // the matching rules (ARCHITECTURE.md section 3 - this codebase's bug history is "the second copy
  // did not get the fix"). Only rows still stored as Ambiguous are re-derived, only the NOTE is
  // taken from the result, and the stored match_status is never overwritten: a row a human resolved
  // through the drawer stays resolved.
  const ambiguous = rows.filter((r) => r.match_status === "Ambiguous");
  const freshNote = new Map<string, string>();
  if (ambiguous.length) {
    const redone = await matchGovtRows(ambiguous as any, {
      batchId: imp.batch?._id ? String(imp.batch._id) : null,
      locationId: imp.location?._id ? String(imp.location._id) : null,
    });
    ambiguous.forEach((r, i) => {
      const d = redone[i];
      if (!d) return;
      // Still colliding -> the current sentence, which names the portal ID and points at this row.
      // No longer colliding -> the stored sentence is now factually wrong (it claims candidates
      // share a name that they no longer do, usually because -137's write-back stamped the ID when
      // its twin was resolved). Say what is true instead of leaving a stale count on screen.
      const which = r.govt_candidate_id?.trim() ? `portal ID ${r.govt_candidate_id.trim()}` : `row ${r.sl_no ?? "?"}`;
      freshNote.set(String(r._id), d.match_status === "Ambiguous" && d.match_note
        ? d.match_note
        : `${which}: the name clash that held this row up is gone - click this row to pick the candidate.`);
    });
  }

  const withVerdict = rows.map((r0) => {
    const r = freshNote.has(String(r0._id)) ? { ...r0, match_note: freshNote.get(String(r0._id)) } : r0;
    const bid = String(r.batch?._id ?? r.batch ?? imp.batch?._id ?? "");
    const bar = bars.get(bid);

    // -127 (QA-180), and this gate comes FIRST because that is the whole bug. A portal export
    // carries the centre's own trainers alongside its students — the live "Attendance_Till 16th Aug"
    // file is 37 Trainee rows and one Trainer, Manish himself at 53:48:25 hrs — and every row was
    // being given an assessment verdict. His own row read "Not eligible" on -106 and "Not enrolled
    // yet" after -109. Both are category errors: nothing about a trainer's hours makes them eligible
    // or ineligible for a STUDENT assessment, and "not eligible" is exactly the filter Manish uses
    // to build the list of students to chase, so it hands him his own trainer.
    //
    // -109 had already written the right answer — but behind `if (!bar)`, and the importer writes
    // `batch: r.batch ?? batchId` onto EVERY row including trainers'. A batch-scoped import (which
    // is how a centre actually uploads) therefore always supplied a bar, always skipped that branch,
    // and the trainer always got a student verdict. Measured in the wall before this line was
    // written: the fixture only reproduced it once the import carried a batch.
    //
    // The test is the EXPORT's own type column, not whether we matched a trainer record — a trainer
    // the ERP has never heard of is still not a candidate for assessment.
    if (isTrainerRow(r)) {
      return {
        ...r,
        govt_hours: r.total_hours_minutes != null ? Math.round(r.total_hours_minutes / 60) : null,
        required_hours: null, qualified: null,
        verdict: {
          state: "trainer", qualified: false,
          label: "Trainer row",
          detail: "the portal export types this row as a trainer, not a candidate — a trainer's hours are their own delivery record, so no student eligibility verdict applies",
        },
      };
    }
    // No bar means no batch to judge against — an unmatched row or an ambiguous one. (Trainers are
    // gone by here: -127 moved them above this, because the bar-fallback to `imp.batch` meant a
    // trainer on a batch-scoped import never reached this branch at all.)
    // -109: it still gets a verdict OBJECT, so every row is accounted for in one of the states and
    // the summary counts always add up to the row count. Found by the counts pin: four such rows
    // carried no verdict at all and silently fell out of every bucket.
    if (!bar) {
      return {
        ...r,
        govt_hours: r.total_hours_minutes != null ? Math.round(r.total_hours_minutes / 60) : null,
        required_hours: null, qualified: null,
        verdict: {
          state: "not_enrolled", qualified: false,
          label: "Not matched to a student",
          detail: `this row is ${String(r.match_status).toLowerCase()}, so there is no enrolled student to judge — resolve the match first`,
        },
      };
    }
    const h = memberAttendedHours({
      internalDays: r.internal_days_present ?? 0,
      hoursPerDay: null, // QA-085: never assume a session length here
      govtMinutes: r.total_hours_minutes,
      requiredHours: bar.required_hours,
    });
    // No hour figure on the portal row is UNKNOWN, not "not eligible" — the shared verdict
    // returns false for both, and saying "not eligible" about a blank would be a lie.
    //
    // -109 (Umesh 17/08): and neither is "below the bar" a verdict while the course is still
    // running. This grid was calling 31 students at Bhadohi "not eligible" three days into a
    // fifteen-day programme. Same shared eligibilityVerdict as the batch Attendance tab, so the two
    // screens cannot say different things about one student. The row's own working-day count is the
    // cohort signal — it is what this very file says about how far along the batch is.
    const b = batchById.get(bid);
    const verdict = eligibilityVerdict({
      // A portal row exists for this person, so the portal has them on the course; the journey gate
      // is the batch member's, and an unmatched row has no member to ask.
      enrollmentStatus: r.match_status === "Matched" && r.batch_member ? "Completed" : null,
      sidhStatus: "Registered",
      attendedHours: h.govt_hours,
      requiredHours: bar.required_hours,
      basis: h.govt_hours == null ? null : "portal",
      courseFinished: courseIsFinished(b, r.total_working_days),
    });
    return { ...r, govt_hours: h.govt_hours, required_hours: bar.required_hours, qualified: h.govt_hours == null ? null : h.qualified, verdict };
  });
  const impBar = bars.get(String(imp.batch?._id ?? "")) ?? (bars.size === 1 ? [...bars.values()][0] : null);

  // -143 (QA-300): derived over the WHOLE import, not over `rows` - rows is filtered, so
  // "matched" or "ambiguous" would answer a question nobody asked and the chip would flip with the
  // filter. Same read-time derivation as the list, same reason.
  const haveLocalLogs = (await GovtAttendanceRow.countDocuments({ import: id, internal_days_present: { $gt: 0 } })) > 0;

  return NextResponse.json({
    item: { ...imp, have_local_logs: haveLocalLogs },
    rows: withVerdict,
    required_hours: impBar?.required_hours ?? null,
    min_attendance_pct: impBar?.min_pct ?? null,
    min_attendance_source: impBar?.source ?? null,
    qualified_count: withVerdict.filter((r) => r.verdict?.state === "qualified").length,
    // -109: split what used to be one "not eligible" bucket. Only the LAST of these is a verdict.
    in_progress_count: withVerdict.filter((r) => r.verdict?.state === "in_progress").length,
    no_hours_count: withVerdict.filter((r) => r.verdict?.state === "no_hours").length,
    not_eligible_count: withVerdict.filter((r) => r.verdict?.state === "not_eligible").length,
    not_enrolled_count: withVerdict.filter((r) => r.verdict?.state === "not_enrolled").length,
    // -127 (QA-180): trainers get their own count so the six buckets still add up to the row count
    // — the -109 invariant — without a trainer hiding inside a student one.
    trainer_count: withVerdict.filter((r) => r.verdict?.state === "trainer").length,
  });
});

// An import is a point-in-time record of what the portal said, so it is deletable (a wrong file,
// a wrong centre) but never editable — correcting it means importing the corrected export.
// -142 (QA-297, Umesh 19/08: "kya ye edit karne ka bhi option rahata hai admin ho agar kisi ke
// paas, ki mistype ko voh thik kar saken?"). MEASURED FIRST, because the sheet could not tell:
// period_label is TYPED, not derived — the drawer's only writer is the operator's own input, and
// the server falls back to the filename only when it is left blank. So "Guguram" for "Gurugram" was
// a human mistype and not a derivation bug, which is what the row's own "Confirm first" asked.
//
// The import itself stays UNEDITABLE — it is a point-in-time record of what the portal said, and
// that rule is why this is a carve-out rather than a general PATCH. The LABEL is different in kind:
// it is OUR name for the import, not portal data, and it is how imports are told apart in a list
// that already holds several. One field, audited, nothing else reachable.
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "attendance.govt");
  const { id } = await ctx.params;
  const imp = await loadInScope(id, user);
  const body = await req.json().catch(() => ({}));
  const label = String(body.period_label ?? "").trim();
  if (!label) throw new HttpError(400, "Give the import a name — it is how this one is told apart from the others.");
  if (label === imp.period_label) return NextResponse.json({ item: imp });
  const was = imp.period_label;
  await GovtAttendanceImport.updateOne({ _id: id }, { $set: { period_label: label } });
  await audit({
    entity: "GovtAttendanceImport", entityId: id, field: "period_label",
    oldValue: was ?? "", newValue: label, actor: user.id, actorType: "USER",
  });
  return NextResponse.json({ item: { ...imp, period_label: label } });
});

export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "attendance.govt");
  const { id } = await ctx.params;
  const imp = await loadInScope(id, user);
  await GovtAttendanceRow.deleteMany({ import: id });
  await GovtAttendanceImport.deleteOne({ _id: id });
  await audit({ entity: "GovtAttendanceImport", entityId: id, field: "delete", oldValue: `${imp.file_name} (${imp.row_count} rows)`, newValue: "", actor: user.id });
  return NextResponse.json({ ok: true });
});
