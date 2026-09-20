import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, readJson, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Defaults } from "@/models";
import { getDefaults } from "@/lib/defaults";
import { audit } from "@/lib/audit";
import { FEE_CAPTURE_UI_EXISTS } from "@/lib/fee-capture";

export const GET = apiHandler(async () => {
  await dbConnect();
  await requireUser();
  return NextResponse.json({ item: await getDefaults() });
});

export const PUT = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "defaults.manage"); // togglable (2026-08-11); Admin-only by default (Rule 40)
  requireEdit(user); // Rule 39: can_edit=false is view-only everywhere, including granted rights
  const body = await readJson(req);
  // QA-2793 (S2): Rule 54 refuses enrollment completion on an unpaid fee once this toggle is
  // ON, and its refusal tells the operator to record the payment on the candidate — but no
  // screen in the product can do that (fee-capture UI removed 14 Aug, 231e687). Arming the
  // toggle with nowhere to satisfy it just reproduces that dead-end, so refuse the arm itself
  // and name the surface that would have to exist first.
  //
  // Guarded on the RAW body value, not on `set` after casting: the Defaults schema field is
  // `Boolean`, and Mongoose casts a string like "true" to a real boolean true on write — so a
  // check placed after the $set (or one that only compared `=== true` against something already
  // cast) would let a non-boolean truthy value slip the guard and land as an armed toggle
  // anyway. Any value other than a genuine `true`/`false` is rejected outright before it ever
  // reaches the update, so this guard cannot be bypassed by a type Mongoose would coerce.
  if (body.fee_required_for_enrollment !== undefined && typeof body.fee_required_for_enrollment !== "boolean") {
    throw new HttpError(400, "fee_required_for_enrollment must be a boolean.");
  }
  if (body.fee_required_for_enrollment === true && !FEE_CAPTURE_UI_EXISTS) {
    throw new HttpError(409, "Rule 54 (QA-2793): fee_required_for_enrollment cannot be turned on — there is no fee-capture UI on the candidate screen for an operator to record fee_paid_on against. Build that surface first, or leave this switch off.");
  }
  const set: Record<string, unknown> = {};
  for (const f of [
    "batch_size", "duration_days", "buffer_days", "completion_deadline_days", "mobilisation_lead_days",
    "attendance_gap_amber", "attendance_gap_red", "daily_log_edit_window_hours", "max_concurrent_batches",
    "enrollment_threshold_pct", "roster_threshold_pct",
    // 2026-08-11 tunables
    "min_age", "max_age", "training_cooldown_months",
    "lead_enrollment_days", "lead_mobilization_days", "lead_trainer_ready_days", "lead_tot_done_days", "lead_tot_start_days", "lead_trainer_ready_for_tot_days", "lead_trainer_found_days", "lead_trainer_mapped_sidh_days",
    "min_daily_evidence", "sidh_url", "drive_root_url", "snapshot_retention_per_tab",
    // -87 (QA-157): media compression knobs
    "image_max_px", "image_quality", "pdf_compress",
    "video_compress", "video_max_height", "video_bitrate_kbps", "video_audio_kbps",
    // 2026-08-12: scheme timing guidelines + client-contract counting rules (Manish)
    "day_start_time", "day_end_time", "max_session_hours", "max_batches_per_day", "max_daily_hours",
    // QA-104 (15/08): max_upload_mb dropped from the whitelist — the app has no size cap.
    "absent_counts_as_appeared", "dropped_pass_is_billable",
    // 2026-08-13: exam-eligibility attendance floor (Manish: "60 plus hona mandatory hai")
    "min_attendance_pct",
    // R-J (QA-049): unpaid fee blocks enrollment completion only when this is on
    "fee_required_for_enrollment",
    // QA-115 (15/08): admin kill-switch for outbound email
    "email_enabled",
  ]) {
    if (body[f] !== undefined) set[f] = body[f];
  }
  const doc = await Defaults.findOneAndUpdate({ _singleton: "defaults" }, { $set: set }, { upsert: true, new: true });
  await audit({ entity: "Defaults", entityId: doc._id, field: "defaults", newValue: set, actor: user.id });
  return NextResponse.json({ item: doc });
});
