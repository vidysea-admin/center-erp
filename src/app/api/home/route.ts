import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { Batch, BatchMember, DailyLog, FollowUpAction, Invoice, Location, SheetChange, TrainerRequest } from "@/models";
import { missingLogQueue } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";

// Home Action Center: the three real conditions by name (§5) + operational queues.
export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  const scope = locationFilter(user);
  const defaults = await getDefaults();

  const [activeLocations, activeBatches, enrolledMembers, openRequests] = await Promise.all([
    Location.countDocuments({ operational_status: "Active", ...(user.role === "Location" ? { _id: { $in: user.location_scope } } : {}) }),
    Batch.countDocuments({ status: "Active", ...scope }),
    BatchMember.countDocuments({ left_on: null, enrollment_status: "Completed" }),
    TrainerRequest.countDocuments({ status: { $in: ["Open", "In Progress"] }, ...scope }),
  ]);

  // Queue 1: missing daily logs (Rule 33)
  const missingLogs = await missingLogQueue(scope);

  // Queue 2: sheet changes pending review (Admin/Operations only)
  const openChanges = ["Admin", "Operations"].includes(user.role)
    ? await SheetChange.find({ status: "Open" }).sort({ detected_at: -1 }).limit(10).populate("location", "name code").lean()
    : [];

  // Rule 38: Location-role users only ever see rows from their own batches
  const scopedBatchIds = user.role === "Location" ? await Batch.find(scope).distinct("_id") : null;
  const batchScope = scopedBatchIds ? { batch: { $in: scopedBatchIds } } : {};

  // Queue 3: govt attendance gap (Rule 31) — recent logs where gap ≥ amber
  const recentLogs = await DailyLog.find({ govt_present: { $ne: null }, ...batchScope })
    .sort({ log_date: -1 }).limit(200)
    .populate({ path: "batch", select: "code location status", populate: { path: "location", select: "name code" } })
    .lean<any[]>();
  const gaps = recentLogs
    .map((l) => {
      const internalPct = l.roster_count ? (100 * l.internal_present) / l.roster_count : 0;
      const govtPct = l.roster_count ? (100 * (l.govt_present ?? 0)) / l.roster_count : 0;
      return { ...l, gap: Math.round(internalPct - govtPct) };
    })
    .filter((l) => l.gap >= defaults.attendance_gap_amber && l.batch?.status === "Active")
    .slice(0, 10);

  // Queue 4: enrollment failures (scoped for Location users)
  const failures = await BatchMember.find({ enrollment_status: "Failed", left_on: null, ...batchScope })
    .populate("candidate", "name phone")
    .populate({ path: "batch", select: "code location", populate: { path: "location", select: "name code" } })
    .limit(20).lean();

  // Queue 5: pending follow-ups — sync workflow belongs to Admin/Operations (Rule 40)
  const followUps = ["Admin", "Operations"].includes(user.role)
    ? await FollowUpAction.find({ status: "Pending" })
        .populate({ path: "source_change", populate: { path: "location", select: "name code" } })
        .limit(20).lean()
    : [];

  // Queue 6: invoices pending
  const invoices = ["Admin", "Operations"].includes(user.role)
    ? await Invoice.find({ status: { $in: ["Ready", "Raised"] } })
        .populate({ path: "batch", select: "code location", populate: { path: "location", select: "name code" } })
        .limit(10).lean()
    : [];

  return NextResponse.json({
    kpis: { active_locations: activeLocations, active_batches: activeBatches, enrolled_students: enrolledMembers, open_trainer_requests: openRequests, pending_followups: followUps.length },
    queues: {
      missing_logs: missingLogs,
      sheet_changes: openChanges,
      attendance_gaps: gaps,
      enrollment_failures: failures,
      follow_ups: followUps,
      invoices_pending: invoices,
    },
    thresholds: { amber: defaults.attendance_gap_amber, red: defaults.attendance_gap_red },
  });
});
