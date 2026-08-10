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
};

export async function getDefaults(): Promise<AppDefaults> {
  let doc = await Defaults.findOne({ _singleton: "defaults" }).lean<AppDefaults>();
  if (!doc) {
    doc = (await Defaults.create({ _singleton: "defaults" })).toObject();
  }
  return doc as AppDefaults;
}
