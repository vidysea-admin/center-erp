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
  max_concurrent_batches: 5,
  enrollment_threshold_pct: 80,
  roster_threshold_pct: 80,
};

export async function getDefaults(): Promise<AppDefaults> {
  const doc = await Defaults.findOne({ _singleton: "defaults" }).lean<Record<string, unknown>>()
    ?? (await Defaults.create({ _singleton: "defaults" })).toObject();
  const merged = { ...DEFAULT_VALUES };
  for (const key of Object.keys(DEFAULT_VALUES) as (keyof AppDefaults)[]) {
    const v = doc?.[key];
    if (typeof v === "number" && Number.isFinite(v)) merged[key] = v;
  }
  return merged;
}
