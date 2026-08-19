import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter, isScoped } from "@/lib/authz";
import { Batch, BatchMember, Candidate, DailyLog, FollowUpAction, GovtAttendanceRow, Invoice, Location, LocationTarget, Program, SheetChange, Trainer, TrainerRequest, User } from "@/models";
import { Types } from "mongoose";
import { ACTIVE_BATCH_STATUSES, addDays, dayStart, istToday, missingLogQueue } from "@/lib/rules";
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
  // -150 (QA-347, found by the checker while testing -147): this union has been INERT for scoped
  // users. requireUser() hands back `location_scope: (fresh.location_scope || []).map(String)`
  // (authz.ts:58) - STRINGS - and Mongoose does no schema casting inside an aggregation pipeline, so
  // `capable_locations: { $in: ['6a85...'] }` never matched an ObjectId. Only the `_id` arm survived,
  // because those ids come back from Batch.distinct() as real ObjectIds. Measured end to end: a
  // Certified trainer whose capable_locations IS the SPOC's centre matched 1 with ObjectIds and 0
  // with strings, and /api/home returned trainers_active_total 0 for that SPOC while the trainer
  // existed. So a scoped centre has been under-counting its own certified trainers - the same
  // family as QA-302, except the filter was not dropped, it silently matched nothing.
  const scopeIds = (user.location_scope ?? []).flatMap((x) => {
    const str = String(x);
    return Types.ObjectId.isValid(str) ? [new Types.ObjectId(str)] : [];
  });
  const trainerScope = isScoped(user)
    ? { $or: [
        { nominated_for_location: { $in: scopeIds } },
        { capable_locations: { $in: scopeIds } },
        { home_location: { $in: scopeIds } },
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
  // QA-101 (15/08): "today" here was the SERVER's calendar day (UTC in the container)
  // while log_date is stored as the IST dayKey — between 00:00 and 05:30 IST the Home
  // card showed yesterday as today. log_date IS a dayKey, so the match is exact equality
  // with istToday(), the one definition of "today" the daily-log path already uses.
  const todayKey = istToday();
  const [attAll] = await DailyLog.aggregate([
    { $match: { ...batchScope } },
    { $group: {
      _id: null,
      present: { $sum: "$internal_present" }, roster: { $sum: "$roster_count" },
      today_present: { $sum: { $cond: [{ $eq: ["$log_date", todayKey] }, "$internal_present", 0] } },
      today_roster: { $sum: { $cond: [{ $eq: ["$log_date", todayKey] }, "$roster_count", 0] } },
    } },
  ]);
  // -138 (G-07, 19/08 recording): the tile read "Total Attendance 12%" from 16 of 135 logged
  // student-days at a centre whose batch page says "Our logs: 0 days" and which had just imported
  // 38 students across 17 portal working days. Umesh's own account of why: these cohorts ran BEFORE
  // this ERP existed, so their attendance was only ever put on the government portal — "attendance
  // same hi hai, bas hum chah rahe hain ki ab hamare system me bhi data aane lage."
  //
  // THE TWO ARE NOT ADDED, and that is the whole design decision. They describe the SAME days: a
  // trainer either marks here or marks on the portal, and for the old cohorts it was the portal.
  // Summing them would double-count every day a diligent centre recorded twice. So per batch we take
  // the PORTAL figure where an import exists and our own logs where it does not — the same "two
  // meters, one truth" split the batch Attendance tab already shows.
  const portalByBatch = await GovtAttendanceRow.aggregate([
    { $match: { match_status: "Matched", ...(("batch" in batchScope) ? batchScope : { batch: { $ne: null } }) } },
    { $sort: { createdAt: -1 } },
    // newest import per candidate wins — a re-import supersedes rather than doubles (checked in -131)
    { $group: { _id: { b: "$batch", c: "$candidate" }, days: { $first: "$total_days_present" }, working: { $first: "$total_working_days" } } },
    { $group: { _id: "$_id.b", present: { $sum: "$days" }, roster: { $sum: "$working" } } },
  ]);
  const portalBatches = new Set(portalByBatch.map((p) => String(p._id)));
  const portalPresent = portalByBatch.reduce((s, p) => s + (p.present ?? 0), 0);
  const portalRoster = portalByBatch.reduce((s, p) => s + (p.roster ?? 0), 0);
  // our own logs, EXCLUDING any batch the portal already answers for
  const [attOurs] = portalBatches.size
    ? await DailyLog.aggregate([
      // -145 (QA-302): this read `{ ...batchScope, batch: { $nin: [...] } }`. batchScope IS
      // `{ batch: { $in: scopedBatchIds } }`, so the literal set `batch` TWICE and its own key won
      // -- the $in vanished and every scoped role's "our logs" half silently counted the whole
      // country. Measured on live -138: the Gurugram SPOC was shown our_present 35 / our_roster 180,
      // byte-identical to the Admin's, while every portal figure beside it was correctly narrowed.
      // Their own two batches are both portal-covered, so their honest figure is 0; the 180 they
      // were shown belongs to Chitrakoot. Rule 38 and LANDMINE L4 both say a scope filter must
      // survive to the query -- here it was dropped by JS, not by logic, which is why it looked
      // right in review.
      //
      // The tell was 12 lines up: the aggregate at :123 avoids the identical collision with an
      // explicit `("batch" in batchScope)` conditional. So both conditions are now built into ONE
      // `batch` object that cannot be overwritten by a sibling key.
      { $match: { batch: { ...(batchScope.batch ?? {}), $nin: [...portalBatches].map((x) => new Types.ObjectId(x)) } } },
      { $group: { _id: null, present: { $sum: "$internal_present" }, roster: { $sum: "$roster_count" } } },
    ])
    : [{ present: attAll?.present ?? 0, roster: attAll?.roster ?? 0 }];
  // QA-012 (checker): "0 of 0 student-days" while the batch page computed 390 expected —
  // the card showed only LOGGED man-days, and with zero logs entered it read as broken.
  // Expected-so-far (roster × operating days elapsed, Active batches) rides along so the
  // card can say "0 logged of 390 expected — no daily logs entered yet" honestly.
  // -102 (Manish 17/08): this same list is what the new "log today's attendance" shortcut
  // needs, so it carries code + centre now instead of a second identical query.
  const activeForExp = await Batch.find({ status: "Active", ...scope })
    .populate("program", "operating_days").populate("location", "name code")
    .select("actual_start program code location").lean<any[]>();
  const expRoster = activeForExp.length ? await BatchMember.aggregate([
    { $match: { batch: { $in: activeForExp.map((b) => b._id) }, left_on: null } },
    { $group: { _id: "$batch", n: { $sum: 1 } } },
  ]) : [];
  const expRosterMap = new Map(expRoster.map((r) => [String(r._id), r.n]));
  let expectedDays = 0;
  const todayD = dayStart(new Date());
  for (const b of activeForExp) {
    if (!b.actual_start) continue;
    // -139 (QA-292, second half): skip the batches the PORTAL answers for — their student-days are
    // already counted from the export's own working-day figure, and counting them here too would put
    // the same days in the denominator twice.
    if (portalBatches.has(String(b._id))) continue;
    const operating: number[] = b.program?.operating_days?.length ? b.program.operating_days : [1, 2, 3, 4, 5, 6];
    let d = dayStart(b.actual_start); let days = 0; let guard = 0;
    while (d <= todayD && guard++ < 366) { if (operating.includes(d.getDay())) days++; d = addDays(d, 1); }
    expectedDays += days * (expRosterMap.get(String(b._id)) ?? 0);
  }
  const present = (attOurs?.present ?? 0) + portalPresent;
  // -139 (QA-292, second half): the denominator used to be `roster_count` summed over DAILY LOGS —
  // only the days somebody happened to log. That is why it read 180 while 247 students are enrolled:
  // a batch nobody logged contributed nothing to the BOTTOM of the fraction, so a centre that
  // recorded nothing scored the same as one with perfect attendance. "Total Attendance" has to
  // divide by the days that SHOULD have happened, and expectedDays is exactly that — it was already
  // in this response, unused. Where nothing is expected yet, the logged roster is the honest floor.
  const ourRoster = Math.max(attOurs?.roster ?? 0, expectedDays);
  const roster = ourRoster + portalRoster;
  // -138 (G-08): nominated = has been put forward for a centre x job role at all; certified-free
  // = Certified AND not named on a live batch. ACTIVE_BATCH_STATUSES is the same list the batch
  // dropdown and the trainers list use, so 'busy' means the same thing in all three places.
  const liveTrainerIds = await Batch.distinct("trainer", { status: { $in: ACTIVE_BATCH_STATUSES }, ...scope });
  const liveSet = new Set(liveTrainerIds.filter(Boolean).map(String));
  // -147 (QA-323, raised by the checker on the -145 FAIL): these two queries carried NO scope at
  // all. They are safe today only because the lean role list withholds these four KPIs from scoped
  // users - i.e. the protection lives in a different file, on a different mechanism, and a future
  // edit that surfaces one of these numbers to a SPOC would silently ship the whole country's
  // figure. QA-302 was exactly that class and cost a live leak, so the scope is applied here rather
  // than relied upon elsewhere. A trainer belongs to a centre through nominated_for_location, which
  // is the same field the nomination KPI already filters on.
  //
  // Written as ONE value per key rather than a spread beside a literal: the first draft of this fix
  // was `{ nominated_for_location: { $ne: null }, ...trainerLocScope }`, which is QA-302's own bug
  // mirrored - the spread silently replaces the key declared before it. It happened to be harmless
  // ($in implies non-null) and that is exactly why it is worth not writing.
  const scopedLocs = isScoped(user) && Array.isArray(user.location_scope) ? user.location_scope : null;
  const [trainersNominated, certifiedDocs] = await Promise.all([
    Trainer.countDocuments({
      active: { $ne: false }, nominated_for_program: { $ne: null },
      nominated_for_location: scopedLocs ? { $in: scopedLocs } : { $ne: null },
    }),
    Trainer.find({
      active: { $ne: false }, pipeline_status: "Certified",
      ...(scopedLocs ? { nominated_for_location: { $in: scopedLocs } } : {}),
    }).select("_id").lean<any[]>(),
  ]);
  const trainersCertified = certifiedDocs.length;
  const trainersCertifiedFree = certifiedDocs.filter((t) => !liveSet.has(String(t._id))).length;

  const attendance = {
    present, roster,
    pct: roster ? Math.round((100 * present) / roster) : null,
    // "today" stays OUR logs only — the portal export is cumulative and carries no per-day figure,
    // so there is no honest way to ask it what happened today.
    today_present: attAll?.today_present ?? 0, today_roster: attAll?.today_roster ?? 0,
    expected_so_far: expectedDays,
    // named separately so the tile can SAY what it counted rather than leaving it to be inferred
    portal_present: portalPresent, portal_roster: portalRoster, portal_batches: portalBatches.size,
    our_present: attOurs?.present ?? 0, our_roster: ourRoster,
  };

  // Queue 1: missing daily logs (Rule 33)
  const missingLogs = await missingLogQueue(scope);

  // -102, Manish 17/08 ([07:09] "teen click pe main chauthe click pe yaha aa raha hu… daily
  // execution aur government attendance wala main dashboard me hi daal dunga"): a trainer signs
  // in and has to hunt for the one thing they came to do. Rule 33's queue above cannot answer
  // this — it reports the PREVIOUS operating day, so a trainer whose batch needs logging TODAY
  // sees an empty Home. This block is today: every Active batch in scope, whether its log is in
  // yet, and the direct door to Daily Execution.
  const loggedTodayIds = new Set(
    (await DailyLog.find({ batch: { $in: activeForExp.map((b) => b._id) }, log_date: todayKey }).select("batch").lean<any[]>())
      .map((l) => String(l.batch)),
  );
  const todayLogging = activeForExp.map((b) => ({
    _id: b._id,
    code: b.code,
    location: b.location ? { _id: b.location._id, name: b.location.name } : null,
    roster_count: expRosterMap.get(String(b._id)) ?? 0,
    logged_today: loggedTodayIds.has(String(b._id)),
  })).sort((a, b) => Number(a.logged_today) - Number(b.logged_today) || String(a.code).localeCompare(String(b.code)));

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

  // QA-096 (checker round 5): the lean Home hid the org-wide CARDS but the API still
  // handed their numbers over — an unscoped Enrollment login read the organisation's
  // centre-approval and target position off the wire. A figure a role is not shown is
  // not sent to it either; the lean roles keep exactly what their Home renders.
  const lean = ["Location", "Trainer", "Enrollment"].includes(user.role);
  const kpis: Record<string, unknown> = {
    active_batches: activeBatches, completed_batches: completedBatches,
    enrolled_students: enrolledMembers, pool_candidates: poolCandidates,
    attendance,
    ...(lean ? {} : {
      approved_locations: approvedLocations, pending_locations: pendingLocations,
      approved_targets: approvedTargets, targets_total: targetsTotal,
      open_trainer_requests: openRequests, fulfilled_trainer_requests: fulfilledRequests,
      // -138 (G-08, Umesh 19/08): the two tiles these replace both read 0 and were not in use.
      // He asked for the numbers he actually needs — how many trainers have been nominated to
      // date, and how many are certified and free to start — and was explicit that the count
      // must be exact with the breakdown alongside: "count toh exact chahiye… kitne available
      // hain, kitna kuch hai, wo sab description me hoga."
      //
      // 'Free to start' is derived EXACTLY as the trainers list derives it (-129's availabilityTag:
      // pipeline_status Certified AND on no live batch), so the tile and that screen cannot
      // disagree about a number a manager will quote out loud.
      trainers_nominated_total: trainersNominated,
      trainers_certified_total: trainersCertified,
      trainers_certified_free: trainersCertifiedFree,
      trainers_certified_busy: trainersCertified - trainersCertifiedFree,
      pending_followups: followUps.length,
      trainers_by_role: trainersByRole,
      trainers_active_total: trainersByRole.reduce((s, r) => s + r.count, 0),
      trainers_on_approved_positions: trainersOnApprovedPositions,
    }),
    // QA-011 (S1): the Active Trainers KPI read 0 for a scoped user while their own
    // trainers page showed a certified trainer. The count above IS scope-aware (the
    // -28 union incl. batch-linked trainers) — the QA-096 trim just stopped sending it,
    // and the card's `?? 0` turned "absent" into a lie. A scoped LOCATION user gets
    // their own centre's numbers (no org figure — the union filter already applied).
    // Trainer role stays without the card: its /trainers link is a 403 for them
    // (QA-058), and central unscoped Enrollment gets nothing org-wide.
    ...(lean && isScoped(user) && user.role === "Location" ? {
      trainers_by_role: trainersByRole,
      trainers_active_total: trainersByRole.reduce((s, r) => s + r.count, 0),
    } : {}),
  };
  return NextResponse.json({
    kpis,
    queues: {
      // -102: goes to the lean roles too — these are their OWN batches, so QA-096's rule
      // ("never ship a figure the role is not shown") is satisfied by construction.
      today_logging: todayLogging,
      missing_logs: missingLogs,
      attendance_gaps: gaps,
      enrollment_failures: failures,
      registration_failed: regFailed,
      pending_users: pendingUsers,
      ...(lean ? {} : {
        sheet_changes: openChanges,
        follow_ups: followUps,
        invoices_pending: invoices,
      }),
    },
    thresholds: { amber: defaults.attendance_gap_amber, red: defaults.attendance_gap_red },
    scoped_no_centres: scopedNoCentres,
  });
});
