import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter, isScoped } from "@/lib/authz";
import { Batch, BatchMember, Candidate, DailyLog, FollowUpAction, Invoice, Location, LocationTarget, Program, SheetChange, Trainer, TrainerRequest, User } from "@/models";
import { addDays, dayStart, missingLogQueue } from "@/lib/rules";
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

  // 2026-08-13 (Manish walkthrough): the government approves each centre×scheme×job-role ROW
  // ("31 approved hain, 10 nahi") — the headline counts approved TARGETS, centres become the sub.
  const [approvedTargets, targetsTotal] = await Promise.all([
    LocationTarget.countDocuments({ tc_status: "Approved", ...locationFilter(user) }),
    LocationTarget.countDocuments({ ...locationFilter(user) }),
  ]);

  // "Total Active Trainers — job role wise": certified trainers grouped by the job role they
  // are nominated for (the same key readiness counts on).
  // QA-011 (checker): the KPI scoped on nominated_for_location ONLY, but the trainers LIST
  // scopes on nominated OR capable OR home — so a certified trainer visible in a scoped
  // user's own list read as 0 on their KPI. Same $or on both surfaces now.
  // …plus the trainer actually RUNNING a batch at a scoped centre — live -14-28 smoke found
  // a Gurugram SPOC still reading 0 while a certified trainer taught their own GGM batch
  // (linked only through the batch, not through nomination/capability/home).
  const scopedBatchTrainers = isScoped(user)
    ? await Batch.find({ ...scope, trainer: { $ne: null } }).distinct("trainer")
    : [];
  const trainerScope = isScoped(user)
    ? { $or: [
        { nominated_for_location: { $in: (user.location_scope ?? []) } },
        { capable_locations: { $in: (user.location_scope ?? []) } },
        { home_location: { $in: (user.location_scope ?? []) } },
        { _id: { $in: scopedBatchTrainers } },
      ] }
    : {};
  const trainerRoleRows = await Trainer.aggregate([
    { $match: { active: true, pipeline_status: "Certified", ...trainerScope } },
    { $group: { _id: "$nominated_for_program", count: { $sum: 1 } } },
  ]);
  const roleProgs = await Program.find({ _id: { $in: trainerRoleRows.map((r) => r._id).filter(Boolean) } }).select("name code scheme").lean<any[]>();
  const progById = new Map(roleProgs.map((p) => [String(p._id), p]));
  const trainersByRole = trainerRoleRows
    .map((r) => ({ program: r._id ? (progById.get(String(r._id))?.name ?? "?") : "No role assigned", code: r._id ? progById.get(String(r._id))?.code ?? null : null, scheme: r._id ? progById.get(String(r._id))?.scheme ?? null : null, count: r.count }))
    .sort((a, b) => b.count - a.count);
  // QA-002 (checker): the Home certified total and the Open Positions board disagreed —
  // the board only counts certified trainers sitting on an APPROVED centre×job-role pair.
  // Both numbers now travel together so the difference is explained, not hidden.
  const apprTargets = await LocationTarget.find({ tc_status: "Approved", ...locationFilter(user) })
    .select("location program").populate("location", "approval_status").lean<any[]>();
  const apprPairs = new Set(apprTargets
    .filter((t) => t.location?.approval_status === "Approved" && t.program)
    .map((t) => `${String(t.location._id)}|${String(t.program)}`));
  const certRows = await Trainer.find({ active: true, pipeline_status: "Certified", ...trainerScope })
    .select("nominated_for_location nominated_for_program").lean<any[]>();
  const trainersOnApprovedPositions = certRows.filter((t) =>
    t.nominated_for_location && t.nominated_for_program &&
    apprPairs.has(`${String(t.nominated_for_location)}|${String(t.nominated_for_program)}`)).length;

  // "Total Attendance" — one aggregate over the daily logs (man-days), plus today's row.
  // internal_present/roster_count are both required at save (Rule 28), so the sums are honest.
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const [attAll] = await DailyLog.aggregate([
    { $match: { ...batchScope } },
    { $group: {
      _id: null,
      present: { $sum: "$internal_present" }, roster: { $sum: "$roster_count" },
      today_present: { $sum: { $cond: [{ $and: [{ $gte: ["$log_date", todayStart] }, { $lte: ["$log_date", todayEnd] }] }, "$internal_present", 0] } },
      today_roster: { $sum: { $cond: [{ $and: [{ $gte: ["$log_date", todayStart] }, { $lte: ["$log_date", todayEnd] }] }, "$roster_count", 0] } },
    } },
  ]);
  // QA-012 (checker): "0 of 0 student-days" while the batch page computed 390 expected —
  // the card showed only LOGGED man-days, and with zero logs entered it read as broken.
  // Expected-so-far (roster × operating days elapsed, Active batches) rides along so the
  // card can say "0 logged of 390 expected — no daily logs entered yet" honestly.
  const activeForExp = await Batch.find({ status: "Active", ...scope })
    .populate("program", "operating_days").select("actual_start program").lean<any[]>();
  const expRoster = activeForExp.length ? await BatchMember.aggregate([
    { $match: { batch: { $in: activeForExp.map((b) => b._id) }, left_on: null } },
    { $group: { _id: "$batch", n: { $sum: 1 } } },
  ]) : [];
  const expRosterMap = new Map(expRoster.map((r) => [String(r._id), r.n]));
  let expectedDays = 0;
  const todayD = dayStart(new Date());
  for (const b of activeForExp) {
    if (!b.actual_start) continue;
    const operating: number[] = b.program?.operating_days?.length ? b.program.operating_days : [1, 2, 3, 4, 5, 6];
    let d = dayStart(b.actual_start); let days = 0; let guard = 0;
    while (d <= todayD && guard++ < 366) { if (operating.includes(d.getDay())) days++; d = addDays(d, 1); }
    expectedDays += days * (expRosterMap.get(String(b._id)) ?? 0);
  }
  const attendance = {
    present: attAll?.present ?? 0, roster: attAll?.roster ?? 0,
    pct: attAll?.roster ? Math.round((100 * attAll.present) / attAll.roster) : null,
    today_present: attAll?.today_present ?? 0, today_roster: attAll?.today_roster ?? 0,
    expected_so_far: expectedDays,
  };

  // Queue 1: missing daily logs (Rule 33)
  const missingLogs = await missingLogQueue(scope);

  // Queue 2: sheet changes pending review — Admin only since R-E (CEO 14/08: the sheet
  // machinery leaves every other persona's view).
  const openChanges = user.role === "Admin"
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
      approved_targets: approvedTargets, targets_total: targetsTotal,
      active_batches: activeBatches, completed_batches: completedBatches,
      enrolled_students: enrolledMembers, pool_candidates: poolCandidates,
      open_trainer_requests: openRequests, fulfilled_trainer_requests: fulfilledRequests,
      pending_followups: followUps.length,
      trainers_by_role: trainersByRole,
      trainers_active_total: trainersByRole.reduce((s, r) => s + r.count, 0),
      trainers_on_approved_positions: trainersOnApprovedPositions,
      attendance,
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
