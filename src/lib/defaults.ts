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
  lead_tot_start_days: number;       // TOT actually begins
  lead_trainer_ready_for_tot_days: number; // trainer available and ready to be sent for TOT
  lead_trainer_found_days: number;   // trainer identified
  lead_trainer_mapped_sidh_days: number; // -164: trainer mapped to this batch on the SIDH portal
  // Daily evidence (2026-08-11: photos/videos "दिन में दो बार कम से कम")
  min_daily_evidence: number;
  // -87 (QA-157): media compression at the storage door
  image_max_px: number;      // longest edge after resize (never upscaled)
  image_quality: number;     // JPEG/WebP quality 30–95
  pdf_compress: boolean;     // Ghostscript /ebook pass on PDFs
  // -91: video compress-first on the device
  video_compress: boolean;
  video_max_height: number;  // 720 → ~11-12 MB per minute at 1500 kbps
  video_bitrate_kbps: number;
  video_audio_kbps: number;
  // SIDH portal registration link sent to candidates
  sidh_url: string;
  // Manish's Drive: RPL project → All Locations → District — the evidence backup root.
  drive_root_url: string;
  // How many changed versions of each sheet tab to keep — the Excel-style version-history depth.
  snapshot_retention_per_tab: number;
  // Scheme timing guidelines (Manish, 2026-08-12)
  day_start_time: string;      // "9 to 6" — a 07:00 start was asked for and refused
  day_end_time: string;
  max_session_hours: number;   // a 4-hour batch is permitted
  max_batches_per_day: number; // two 4-hour batches; three 3-hour batches was refused
  max_daily_hours: number;     // QA-144: CEO's 8-hour rule — slot-hours a trainer may teach per day
  // Client-contract counting rules (Manish, 2026-08-12)
  absent_counts_as_appeared: boolean; // absentees are NOT deducted from "appeared"
  dropped_pass_is_billable: boolean;  // a dropout who passed is not billable
  // QA-104 (2026-08-15): max_upload_mb REMOVED from the tunables — the app has NO size
  // cap by Umesh's order, so a 100 MB figure here was a lie twice over. The schema field
  // stays dormant; it just never surfaces or enforces anything again.
  // Exam eligibility: minimum attendance as a percent of programme hours (2026-08-13)
  min_attendance_pct: number;
  // R-J (QA-049): does an unpaid fee BLOCK enrollment completion? OFF by default —
  // government-funded schemes charge the candidate nothing.
  fee_required_for_enrollment: boolean;
  // QA-115 (2026-08-15): admin kill-switch for outbound email. The REAL gate is the SES
  // env credentials (absent = mail silently off); this lets an Admin mute mail without a
  // redeploy. Credentials themselves NEVER live here — defaults are readable by every
  // authenticated user.
  email_enabled: boolean;
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
  image_max_px: 1600,
  image_quality: 75,
  pdf_compress: true,
  video_compress: true,
  video_max_height: 720,
  video_bitrate_kbps: 1500,
  video_audio_kbps: 64,
  lead_tot_start_days: 10,
  lead_trainer_ready_for_tot_days: 15,
  lead_trainer_found_days: 20,
  lead_trainer_mapped_sidh_days: 5,
  min_daily_evidence: 2,
  sidh_url: "https://www.skillindiadigital.gov.in/",
  drive_root_url: "https://drive.google.com/drive/folders/1NOfRCw9lIyRoJTEFAg4--HIJiTG-Of0G",
  snapshot_retention_per_tab: 100,
  day_start_time: "09:00",
  day_end_time: "18:00",
  max_session_hours: 4,
  max_batches_per_day: 2,
  max_daily_hours: 8,
  absent_counts_as_appeared: true,
  dropped_pass_is_billable: false,
  // 2026-08-13 (Manish): exam eligibility = this percent of programme hours attended.
  min_attendance_pct: 50,
  fee_required_for_enrollment: false,
  email_enabled: true,
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
    // Booleans must accept a stored `false` — the falsy checks above would silently drop it.
    if (want === "boolean" && typeof v === "boolean") (merged as any)[key] = v;
  }
  return merged;
}
