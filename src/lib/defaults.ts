import { Defaults } from "@/models";

export type AppDefaults = {
  batch_size: number;
  duration_days: number;
  buffer_days: number;
  completion_deadline_days: number;
  mobilisation_lead_days: number;
  attendance_gap_amber: number;
  attendance_gap_red: number;
  daily_log_edit_window_hours: number;
  max_concurrent_batches: number;
  enrollment_threshold_pct: number;
  roster_threshold_pct: number;
  // Candidate eligibility (2026-08-11 meeting: "ऐसे पांच-सात criteria होते हैं")
  min_age: number;
  max_age: number;
  training_cooldown_months: number;
  // Backward batch planner lead times, in days before batch start (2026-08-11)
  lead_enrollment_days: number;      // registration + enrollment done
  lead_mobilization_days: number;    // mobilization complete
  lead_trainer_ready_days: number;   // trainer finalized/trained
  lead_tot_done_days: number;        // "TOT done has to be at least three days before the batch start"
  lead_trainer_found_days: number;   // trainer identified
  // Daily evidence (2026-08-11: photos/videos "दिन में दो बार कम से कम")
  min_daily_evidence: number;
  // SIDH portal registration link sent to candidates
  sidh_url: string;
};

// Fallbacks for every tunable. A Defaults document written before a field existed simply
// lacks it, so merging here means adding a new default never needs a data migration.
export const DEFAULT_VALUES: AppDefaults = {
  batch_size: 30,
  duration_days: 15,
  buffer_days: 5,
  completion_deadline_days: 90,
  mobilisation_lead_days: 7,
  attendance_gap_amber: 5,
  attendance_gap_red: 10,
  daily_log_edit_window_hours: 48,
  max_concurrent_batches: 4, // 2026-08-11: "up to four batches का provision" (was 5)
  enrollment_threshold_pct: 80,
  roster_threshold_pct: 80,
  min_age: 18,
  max_age: 40,
  training_cooldown_months: 6,
  lead_enrollment_days: 1,
  lead_mobilization_days: 2,
  lead_trainer_ready_days: 1,
  lead_tot_done_days: 3,
  lead_trainer_found_days: 7,
  min_daily_evidence: 2,
  sidh_url: "https://www.skillindiadigital.gov.in/",
};

export async function getDefaults(): Promise<AppDefaults> {
  const doc = await Defaults.findOne({ _singleton: "defaults" }).lean<Record<string, unknown>>()
    ?? (await Defaults.create({ _singleton: "defaults" })).toObject();
  const merged = { ...DEFAULT_VALUES };
  for (const key of Object.keys(DEFAULT_VALUES) as (keyof AppDefaults)[]) {
    const v = doc?.[key];
    const want = typeof DEFAULT_VALUES[key];
    if (want === "number" && typeof v === "number" && Number.isFinite(v)) (merged as any)[key] = v;
    if (want === "string" && typeof v === "string" && v.trim() !== "") (merged as any)[key] = v;
  }
  return merged;
}
