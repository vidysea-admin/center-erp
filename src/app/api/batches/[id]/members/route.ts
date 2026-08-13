import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, assertLocationInScope } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, Candidate, DailyLog, GovtAttendanceRow } from "@/models";
import { addMemberChecked, assertBatchInScope, assertLocationOperational } from "@/lib/rules";
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
  const candIds = items.map((m: any) => m.candidate?._id).filter(Boolean);
  const govtLatest = candIds.length ? await GovtAttendanceRow.aggregate([
    { $match: { candidate: { $in: candIds }, match_status: "Matched" } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$candidate", days_present: { $first: "$total_days_present" }, working_days: { $first: "$total_working_days" }, as_of: { $first: "$createdAt" } } },
  ]) : [];
  const govtBy = new Map(govtLatest.map((g: any) => [String(g._id), g]));

  const withAttendance = items.map((m: any) => ({
    ...m,
    attendance: {
      present: presentDays.get(String(m._id)) ?? 0,
      days_held: daysHeld,
      pct: daysHeld ? Math.round((100 * (presentDays.get(String(m._id)) ?? 0)) / daysHeld) : null,
    },
    govt_attendance: govtBy.get(String(m.candidate?._id)) ?? null,
  }));
  return NextResponse.json({ items: withAttendance });
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
  if (String(cand.location) !== String(batch.location)) {
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
  await audit({ entity: "BatchMember", entityId: m._id, newValue: "assigned", actor: user.id });
  return NextResponse.json({ item: m, warning: (m as any).warning }, { status: 201 });
});
