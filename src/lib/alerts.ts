// Alert engine (RPL M22) — evaluates SLA/threshold conditions and raises in-app
// notifications. Deliberately pull-free for the user: the scheduler writes rows, the UI
// reads them. Every rule is deduped by (type, entity_id) so a standing condition raises
// once, not once per tick.
import {
  Batch, Closure, DailyLog, Invoice, Notification, SheetChange, TrainerRequest, WorkbookChange,
} from "@/models";
import { getDefaults } from "@/lib/defaults";
import { addDays, assessmentCompleteness, dayRange, dayStart, missingLogStreak } from "@/lib/rules";

type Raise = {
  type: string;
  severity?: "info" | "warning" | "critical";
  message: string;
  entity?: string;
  entity_id?: unknown;
  link?: string;
  location?: unknown;
  role_target?: string[];
  due_at?: Date;
};

// Creates the alert only if an unresolved one for the same condition+entity is absent.
async function raise(a: Raise) {
  const existing = await Notification.findOne({
    type: a.type,
    entity_id: a.entity_id ?? null,
    status: { $in: ["New", "Acknowledged"] },
  }).select("_id").lean();
  if (existing) return false;
  await Notification.create({ severity: "warning", role_target: ["Admin", "Operations"], ...a });
  return true;
}

// Auto-close alerts whose condition no longer holds, so the list reflects reality
// rather than history.
async function clear(type: string, entityIds: unknown[]) {
  await Notification.updateMany(
    { type, status: { $in: ["New", "Acknowledged"] }, ...(entityIds.length ? { entity_id: { $nin: entityIds } } : {}) },
    { $set: { status: "Resolved" } },
  );
}

export async function evaluateAlerts(): Promise<{ raised: number; checked: string[] }> {
  const defaults = await getDefaults();
  const now = new Date();
  let raised = 0;
  const checked: string[] = [];

  // 1. Sheet change pending review for more than 48 hours (doc M2).
  checked.push("sheet_change_stale");
  const staleChanges = await SheetChange.find({
    status: "Open",
    detected_at: { $lt: new Date(now.getTime() - 48 * 3600e3) },
  }).populate("location", "name").lean<any[]>();
  for (const c of staleChanges) {
    if (await raise({
      type: "sheet_change_stale", severity: "warning",
      message: `Sheet change for ${c.location?.name ?? "an unmatched location"} (${c.field_name}) has been awaiting review for over 48 hours`,
      entity: "SheetChange", entity_id: c._id, link: "/sync", location: c.location?._id,
    })) raised++;
  }
  await clear("sheet_change_stale", staleChanges.map((c) => c._id));

  // 1b. Workbook Watch change unreviewed for more than 48 hours (2026-08-11 meeting) —
  // one alert per source+tab, not per cell, so a big client edit doesn't flood the bell.
  checked.push("workbook_change_stale");
  const staleWatch = await WorkbookChange.aggregate([
    { $match: { status: "New", detected_at: { $lt: new Date(now.getTime() - 48 * 3600e3) } } },
    { $group: { _id: { source: "$sync_source", tab: "$tab" }, count: { $sum: 1 }, oldest: { $min: "$detected_at" } } },
  ]);
  const staleWatchIds: unknown[] = [];
  for (const g of staleWatch) {
    staleWatchIds.push(g._id.source);
    if (await raise({
      type: "workbook_change_stale", severity: "warning",
      message: `${g.count} workbook change(s) on tab "${g._id.tab}" have been awaiting review for over 48 hours`,
      entity: "SyncSource", entity_id: g._id.source, link: "/sheet-watch",
    })) raised++;
  }
  await clear("workbook_change_stale", staleWatchIds);

  // 2. Trainer request whose required-by date is near with no fulfilment (doc M7).
  checked.push("trainer_request_due");
  const dueRequests = await TrainerRequest.find({
    status: { $in: ["Open", "In Progress"] },
    required_by_date: { $lt: addDays(now, 7) },
  }).populate("location", "name").populate("program", "name").lean<any[]>();
  for (const t of dueRequests) {
    if (await raise({
      type: "trainer_request_due",
      severity: new Date(t.required_by_date) < now ? "critical" : "warning",
      message: `Trainer for ${t.program?.name} at ${t.location?.name} required by ${new Date(t.required_by_date).toLocaleDateString("en-IN")} — still ${t.status}`,
      entity: "TrainerRequest", entity_id: t._id, link: "/trainers?tab=Requests",
      location: t.location?._id, due_at: t.required_by_date,
    })) raised++;
  }
  await clear("trainer_request_due", dueRequests.map((t) => t._id));

  // 3. Active batch with no daily log for 2+ operating days (doc M13/M14).
  checked.push("daily_log_overdue");
  const activeBatches = await Batch.find({ status: "Active" }).populate("program", "operating_days").populate("location", "name").lean<any[]>();
  const logLate: unknown[] = [];
  for (const b of activeBatches) {
    const operating: number[] = b.program?.operating_days?.length ? b.program.operating_days : [1, 2, 3, 4, 5, 6];
    const { days } = await missingLogStreak(b, operating);
    if (days >= 2) {
      logLate.push(b._id);
      if (await raise({
        type: "daily_log_overdue", severity: days >= 3 ? "critical" : "warning",
        message: `${b.code} at ${b.location?.name} has no daily log for ${days} operating days`,
        entity: "Batch", entity_id: b._id, link: `/batches/${b._id}?tab=Daily Execution`,
        location: b.location?._id, role_target: ["Admin", "Operations", "Location", "Trainer"],
      })) raised++;
    }
  }
  await clear("daily_log_overdue", logLate);

  // 4. Government attendance mismatch beyond the red threshold (doc M15).
  checked.push("attendance_mismatch");
  const recent = await DailyLog.find({ govt_present: { $ne: null }, log_date: { $gte: addDays(dayStart(now), -7) } })
    .populate({ path: "batch", select: "code status location", populate: { path: "location", select: "name" } })
    .lean<any[]>();
  const gapBatches: unknown[] = [];
  for (const l of recent) {
    if (!l.roster_count || l.batch?.status !== "Active") continue;
    const gap = Math.round((100 * l.internal_present) / l.roster_count - (100 * (l.govt_present ?? 0)) / l.roster_count);
    if (gap >= defaults.attendance_gap_red && !gapBatches.includes(String(l.batch._id))) {
      gapBatches.push(l.batch._id);
      if (await raise({
        type: "attendance_mismatch", severity: "critical",
        message: `${l.batch.code} at ${l.batch.location?.name}: government attendance is ${gap} points below internal on ${new Date(l.log_date).toLocaleDateString("en-IN")}`,
        entity: "Batch", entity_id: l.batch._id, link: `/batches/${l.batch._id}?tab=Daily Execution`,
        location: l.batch.location?._id, role_target: ["Admin", "Operations", "Location", "Trainer"],
      })) raised++;
    }
  }
  await clear("attendance_mismatch", gapBatches);

  // 4b. Daily evidence below the minimum (2026-08-11: "दिन में दो बार कम से कम… photos,
  // videos"). Checks yesterday's log for Active batches.
  checked.push("evidence_low");
  const yesterday = addDays(dayStart(now), -1);
  const evLow: unknown[] = [];
  for (const b of activeBatches) {
    const operating: number[] = b.program?.operating_days?.length ? b.program.operating_days : [1, 2, 3, 4, 5, 6];
    if (!operating.includes(yesterday.getDay())) continue;
    const log = await DailyLog.findOne({ batch: b._id, log_date: dayRange(yesterday) }).select("photos videos").lean<any>();
    const count = (log?.photos?.length ?? 0) + (log?.videos?.length ?? 0);
    if (log && count < (defaults.min_daily_evidence ?? 2)) {
      evLow.push(b._id);
      if (await raise({
        type: "evidence_low", severity: "warning",
        message: `${b.code} at ${b.location?.name}: only ${count} photo/video upload(s) yesterday — minimum is ${defaults.min_daily_evidence}`,
        entity: "Batch", entity_id: b._id, link: `/batches/${b._id}?tab=Daily Execution`,
        location: b.location?._id, role_target: ["Admin", "Operations", "Location", "Trainer"],
      })) raised++;
    }
  }
  await clear("evidence_low", evLow);

  // 4c. Backward-plan milestone overdue and not ticked off (2026-08-11 planner).
  checked.push("milestone_overdue");
  // QA-152 (-81): only a REQUESTED plan raises overdue alerts (pre--81 auto-milestones stay silent).
  const planned = await Batch.find({ status: { $in: ["Planning", "Ready"] }, plan_enabled: true, "milestones.0": { $exists: true } })
    .populate("location", "name").lean<any[]>();
  const msLate: unknown[] = [];
  for (const b of planned) {
    const overdue = (b.milestones ?? []).filter((m: any) => !m.done_on && m.due_date && new Date(m.due_date) < dayStart(now));
    if (overdue.length) {
      msLate.push(b._id);
      if (await raise({
        type: "milestone_overdue", severity: "warning",
        message: `${b.code} at ${b.location?.name}: ${overdue.length} plan milestone(s) overdue — next: "${overdue[0].label}" was due ${new Date(overdue[0].due_date).toLocaleDateString("en-IN")}`,
        entity: "Batch", entity_id: b._id, link: `/batches/${b._id}`,
        location: b.location?._id,
      })) raised++;
    }
  }
  await clear("milestone_overdue", msLate);

  // 5. Assessment date has passed but results are incomplete (doc M17).
  checked.push("assessment_overdue");
  const closures = await Closure.find({
    assessment_status: "Pending",
    assessment_date: { $ne: null, $lt: dayStart(now) },
  }).populate({ path: "batch", select: "code status location", populate: { path: "location", select: "name" } }).lean<any[]>();
  const assessLate: unknown[] = [];
  for (const c of closures) {
    if (!c.batch || ["Completed", "Cancelled"].includes(c.batch.status)) continue;
    const completeness = await assessmentCompleteness(String(c.batch._id));
    if (completeness.legacy || !completeness.complete) {
      assessLate.push(c.batch._id);
      if (await raise({
        type: "assessment_overdue", severity: "warning",
        message: `${c.batch.code}: assessment date has passed${completeness.legacy ? "" : ` with ${completeness.total - completeness.final} result(s) still pending`}`,
        entity: "Batch", entity_id: c.batch._id, link: `/batches/${c.batch._id}?tab=Closure`,
        location: c.batch.location?._id,
      })) raised++;
    }
  }
  await clear("assessment_overdue", assessLate);

  // 6. Invoice eligible but not raised within 7 days (doc M19).
  checked.push("invoice_not_raised");
  const readyInvoices = await Invoice.find({ status: "Ready", updatedAt: { $lt: addDays(now, -7) } })
    .populate({ path: "batch", select: "code location", populate: { path: "location", select: "name" } }).lean<any[]>();
  for (const inv of readyInvoices) {
    if (await raise({
      type: "invoice_not_raised", severity: "warning",
      message: `${inv.batch?.code} at ${inv.batch?.location?.name} has been ready to invoice for over a week`,
      entity: "Invoice", entity_id: inv._id, link: `/batches/${inv.batch?._id}?tab=Closure`,
      location: inv.batch?.location?._id,
    })) raised++;
  }
  await clear("invoice_not_raised", readyInvoices.map((i) => i._id));

  // 7. Batch stuck in Planning past its own start date (doc M10).
  checked.push("batch_stuck_planning");
  const stuck = await Batch.find({ status: { $in: ["Planning", "Ready"] }, planned_start: { $lt: dayStart(now) } })
    .populate("location", "name").lean<any[]>();
  for (const b of stuck) {
    if (await raise({
      type: "batch_stuck_planning", severity: "warning",
      message: `${b.code} at ${b.location?.name} was due to start on ${new Date(b.planned_start).toLocaleDateString("en-IN")} and is still ${b.status}`,
      entity: "Batch", entity_id: b._id, link: `/batches/${b._id}`, location: b.location?._id,
    })) raised++;
  }
  await clear("batch_stuck_planning", stuck.map((b) => b._id));

  return { raised, checked };
}
