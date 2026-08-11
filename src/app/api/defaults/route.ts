import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { Defaults } from "@/models";
import { getDefaults } from "@/lib/defaults";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async () => {
  await dbConnect();
  await requireUser();
  return NextResponse.json({ item: await getDefaults() });
});

export const PUT = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin"); // Rule 40
  const body = await req.json();
  const set: Record<string, unknown> = {};
  for (const f of [
    "batch_size", "duration_days", "buffer_days", "completion_deadline_days", "mobilisation_lead_days",
    "attendance_gap_amber", "attendance_gap_red", "daily_log_edit_window_hours", "max_concurrent_batches",
    "enrollment_threshold_pct", "roster_threshold_pct",
    // 2026-08-11 tunables
    "min_age", "max_age", "training_cooldown_months",
    "lead_enrollment_days", "lead_mobilization_days", "lead_trainer_ready_days", "lead_tot_done_days", "lead_trainer_found_days",
    "min_daily_evidence", "sidh_url",
  ]) {
    if (body[f] !== undefined) set[f] = body[f];
  }
  const doc = await Defaults.findOneAndUpdate({ _singleton: "defaults" }, { $set: set }, { upsert: true, new: true });
  await audit({ entity: "Defaults", entityId: doc._id, field: "defaults", newValue: set, actor: user.id });
  return NextResponse.json({ item: doc });
});
