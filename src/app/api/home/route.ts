import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter, isScoped } from "@/lib/authz";
import { Batch, BatchMember, Candidate, DailyLog, FollowUpAction, Invoice, Location, SheetChange, TrainerRequest, User } from "@/models";
import { missingLogQueue } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";

// Home Action Center: the three real conditions by name (§5) + operational queues.
export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  const scope = locationFilter(user);
  const defaults = await getDefaults();

  // Rule 38: every scoped user (Location, and Enrollment when a scope is set) sees only
  // their own locations' rows — including the KPI counts.
  const scopedBatchIds = isScoped(user) ? await Batch.find(scope).distinct("_id") : null;
  const batchScope = scopedBatchIds ? { batch: { $in: scopedBatchIds } } : {};

  // 2026-08-13, found live after the data reset: a scoped user whose centres no longer exist
  // (their demo centre was purged) signs in to a wall of zeros with no explanation. Nothing is
  // broken — but a blank app reads as broken, so say WHY it is empty.
  const scopedNoCentres = isScoped(user)
    ? (await Location.countDocuments({ ...locationFilter(user, "_id") })) === 0
    : false;

  // 2026-08-13 (Manish): "approved location mein aap yeh tab ka naam approved location kar
  // sakte hain" — the headline KPI counts centres the scheme has APPROVED (approval_status),
  // not merely operationally-active ones. Job-role-wise approval detail is the existing
  // "Centres Ready to Start" section (location × program readiness) below it.
  // 2026-08-13 (Umesh): "ek ke baad do count — active kitne AUR complete kitne, approved
  // AUR pending" — each KPI carries its natural second number so the card answers the
  // follow-up question without a click.
  const [approvedLocations, pendingLocations, activeBatches, completedBatches, enrolledMembers, poolCandidates, openRequests, fulfilledRequests] = await Promise.all([
    Location.countDocuments({ approval_status: "Approved", ...locationFilter(user, "_id") }),
    Location.countDocuments({ approval_status: "Pending", ...locationFilter(user, "_id") }),
    Batch.countDocuments({ status: "Active", ...scope }),
    Batch.countDocuments({ status: "Completed", ...scope }),
    BatchMember.countDocuments({ left_on: null, enrollment_status: "Completed", ...batchScope }),
    Candidate.countDocuments({ ...scope }),
    TrainerRequest.countDocuments({ status: { $in: ["Open", "In Progress"] }, ...scope }),
    TrainerRequest.countDocuments({ status: "Fulfilled", ...scope }),
  ]);

  // Queue 1: missing daily logs (Rule 33)
  const missingLogs = await missingLogQueue(scope);

  // Queue 2: sheet changes pending review (Admin/Operations only)
  const openChanges = ["Admin", "Operations"].includes(user.role)
    ? await SheetChange.find({ status: "Open" }).sort({ detected_at: -1 }).limit(10).populate("location", "name code").lean()
    : [];

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

  // Queue 4b (GD-81): candidates the portal refused. "Main bacche ko drop karke doosri queue
  // mein dalunga" — these are worked on for registration, not planned into batches.
  const regFailed = await Candidate.find({ sidh_status: "Registration Failed", ...scope })
    .select("name phone sidh_failure_reason location")
    .populate("location", "name code")
    .sort({ updatedAt: -1 }).limit(20).lean();

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

  // Queue 7: signups waiting on an Admin (2026-08-12). These were only visible if you
  // happened to open Admin → Users, so the person who has to act never saw them. Full
  // contact details ride along — an approver decides on who this is, not just a name.
  const pendingUsers = user.role === "Admin"
    ? await User.find({ approval_status: "Pending" })
        .select("name email phone role requested_role location_scope createdAt")
        .populate("location_scope", "name code")
        .sort({ createdAt: -1 }).limit(10).lean()
    : [];

  return NextResponse.json({
    kpis: {
      approved_locations: approvedLocations, pending_locations: pendingLocations,
      active_batches: activeBatches, completed_batches: completedBatches,
      enrolled_students: enrolledMembers, pool_candidates: poolCandidates,
      open_trainer_requests: openRequests, fulfilled_trainer_requests: fulfilledRequests,
      pending_followups: followUps.length,
    },
    queues: {
      missing_logs: missingLogs,
      sheet_changes: openChanges,
      attendance_gaps: gaps,
      enrollment_failures: failures,
      registration_failed: regFailed,
      follow_ups: followUps,
      invoices_pending: invoices,
      pending_users: pendingUsers,
    },
    thresholds: { amber: defaults.attendance_gap_amber, red: defaults.attendance_gap_red },
    scoped_no_centres: scopedNoCentres,
  });
});
