import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, assertLocationInScope } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, Candidate, DailyLog, GovtAttendanceRow } from "@/models";
import { addMemberChecked, assertBatchInScope, assertLocationOperational, assessmentHoursBar, awaitingMatchFor, memberAttendedHours, slotHoursPerDay } from "@/lib/rules";
import { nameKey, unresolvedPortalRowsByName } from "@/lib/govt-attendance";
import { getDefaults } from "@/lib/defaults";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const items = await BatchMember.find({ batch: id }).populate("candidate", "name phone lifecycle_status").sort({ joined_on: 1 }).lean();

  // GD-102: "kitne bacche ki kitni-kitni attendance chal rahi hai" — each member's running
  // attendance, counted from the daily logs rather than stored anywhere it could go stale.
  const logs = await DailyLog.find({ batch: id }).select("present_member_ids").lean<any[]>();
  const daysHeld = logs.length;
  const presentDays = new Map<string, number>();
  for (const l of logs) {
    for (const mid of l.present_member_ids ?? []) {
      const k = String(mid);
      presentDays.set(k, (presentDays.get(k) ?? 0) + 1);
    }
  }
  // 2026-08-13: the government portal's cumulative figure per candidate (latest import wins) —
  // the roster shows both meters side by side, internal log days and portal days.
  // QA-070 (-70): hours ride along now — this API never even FETCHED total_hours_minutes,
  // which is why the roster showed days while the CEO asked for hours.
  const candIds = items.map((m: any) => m.candidate?._id).filter(Boolean);
  const govtLatest = candIds.length ? await GovtAttendanceRow.aggregate([
    { $match: { candidate: { $in: candIds }, match_status: "Matched" } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$candidate", days_present: { $first: "$total_days_present" }, working_days: { $first: "$total_working_days" }, hours_minutes: { $first: "$total_hours_minutes" }, as_of: { $first: "$createdAt" } } },
  ]) : [];
  const govtBy = new Map(govtLatest.map((g: any) => [String(g._id), g]));

  // One bar, one verdict — the same shared formulas as the Attendance tab and the portal.
  const batchDoc = await Batch.findById(id).populate("program", "hours duration_days scheme").select("program slot_start slot_end location").lean<any>();
  const defaults = await getDefaults();
  const { requiredHours } = await assessmentHoursBar(batchDoc?.program?.scheme, batchDoc?.program, defaults.min_attendance_pct ?? 50);
  const hoursPerDay = slotHoursPerDay(batchDoc);
  // -153 (QA-293): this roster showed both Sachin Kumars as "~0/60 hrs" - an estimate off OUR
  // daily logs, which hold no present days for them - while their real portal hours sat in this
  // database. The estimate was honest about its own basis and still said "~0" about students who
  // had cleared the bar. The chip needs to know an unattached row exists so it can say so instead.
  const awaitingByName = await unresolvedPortalRowsByName({ batchId: id, locationId: batchDoc?.location });

  const withAttendance = items.map((m: any) => {
    const g = govtBy.get(String(m.candidate?._id));
    const h = memberAttendedHours({ internalDays: presentDays.get(String(m._id)) ?? 0, hoursPerDay, govtMinutes: g?.hours_minutes, requiredHours });
    // -153 cycle 3 (QA-419): the same helper as the other two surfaces, not a re-typed condition.
    // Cycle 2 wrote this test out by hand here and inside eligibilityVerdict and again in the
    // public route, and the three drifted the moment a member was not enrolled.
    const awaiting = awaitingMatchFor({ basis: h.basis, hit: awaitingByName.get(nameKey(m.candidate?.name)) });
    return {
      ...m,
      attendance: {
        present: presentDays.get(String(m._id)) ?? 0,
        days_held: daysHeld,
        pct: daysHeld ? Math.round((100 * (presentDays.get(String(m._id)) ?? 0)) / daysHeld) : null,
      },
      govt_attendance: g ?? null,
      hours: { ...h, required_hours: requiredHours, awaiting_match: awaiting },
    };
  });
  return NextResponse.json({ items: withAttendance, required_hours: requiredHours });
});

// POST { candidate, joined_on? } — add one member (Rules 20–21)
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.assign"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const batch = await Batch.findById(id).select("status location program").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  if (["Completed", "Cancelled"].includes(batch.status)) throw new HttpError(409, "Batch is closed.");
  await assertLocationOperational(batch.location, "Adding a candidate"); // Rule 1
  const body = await req.json();
  if (!body.candidate) throw new HttpError(400, "candidate is required");
  const cand = await Candidate.findById(body.candidate).select("name location program").lean<any>();
  if (!cand) throw new HttpError(404, "Candidate not found");
  assertLocationInScope(user, String(cand.location)); // Rule 38 on the candidate too
  // 2026-08-13 (Manish walkthrough — other centres' candidates on the pool): membership
  // requires the batch's own centre and job role. assertLocationInScope is a no-op for
  // Admin/Operations, so equality is checked explicitly for everyone.
  // -124 (M4-04): a candidate with NO centre is not "at another centre" — they are unplaced, which is
  // exactly what a walk-in is. Enrolling them here is the event that decides it (adopted below, the
  // same way a programme-less candidate adopts the batch's programme). Someone who DOES belong to
  // another centre is still refused: that rule is Manish's own, from the 13/08 walkthrough.
  if (cand.location && String(cand.location) !== String(batch.location)) {
    throw new HttpError(409, `${cand.name ?? "Candidate"} belongs to another centre — move them to this location first.`);
  }
  if (cand.program && batch.program && String(cand.program) !== String(batch.program)) {
    throw new HttpError(409, `${cand.name ?? "Candidate"} is registered under a different job role/scheme than this batch.`);
  }
  const m = await addMemberChecked(id, body.candidate, body.joined_on ? new Date(body.joined_on) : new Date());
  // Import convention: program-less candidates inherit the batch's programme on enrolment.
  if (!cand.program && batch.program) {
    await Candidate.updateOne({ _id: body.candidate }, { $set: { program: batch.program } });
  }
  // -124 (M4-04): and a candidate with no centre adopts this one. Audited by name, because it changes
  // who can see the record from that moment on (Rule 38 scoping keys on exactly this field).
  if (!cand.location && batch.location) {
    await Candidate.updateOne({ _id: body.candidate }, { $set: { location: batch.location } });
    await audit({ entity: "Candidate", entityId: body.candidate, field: "location",
      oldValue: "(none — walk-in)", newValue: `set to this batch's centre on enrolment (${batch.code ?? id})`, actor: user.id });
  }
  await audit({ entity: "BatchMember", entityId: m._id, newValue: "assigned", actor: user.id });
  return NextResponse.json({ item: m, warning: (m as any).warning }, { status: 201 });
});
