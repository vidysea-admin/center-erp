import mongoose, { Schema, model, models, Types } from "mongoose";

// Enums (locked v1 — center-erp-data-model-rules.md §2)
export const APPROVAL_STATUS = ["Pending", "Approved", "Rejected"] as const;
export const OPERATIONAL_STATUS = ["Not Started", "Active", "On Hold", "Stopped", "Closed"] as const;
export const ROOM_TYPE = ["Classroom", "Lab"] as const;
export const TRAINER_STATUS = ["Available", "Assigned", "Unavailable"] as const;
export const TRAINER_REQUEST_STATUS = ["Open", "In Progress", "Fulfilled", "Cancelled"] as const;
// "Not Certified" (RPL M17/M18): finished the batch but did not pass — not Completed
// (which would inflate outcome reporting) and not Dropped (they never left).
export const LIFECYCLE_STATUS = ["Unassigned", "Assigned", "Enrolled", "Dropped", "Completed", "Not Certified"] as const;
export const ASSESSMENT_RESULT = ["Pending", "Pass", "Fail", "Absent"] as const;
export const CERTIFICATE_STATUS = ["Pending", "Processing", "Generated", "Issued", "Rejected"] as const;
export const BATCH_SESSION = ["Morning", "Afternoon", "Full Day"] as const;
export const BATCH_STATUS = ["Planning", "Ready", "Active", "Closing", "Completed", "Cancelled"] as const;
export const ENROLLMENT_STATUS = ["Not Started", "In Progress", "Completed", "Failed"] as const;
export const ENROLLMENT_ISSUE = ["OTP not received", "Already registered", "KYC failed", "Portal error", "Duplicate", "Other"] as const;
export const MEMBER_SOURCE = ["Manual", "Automation"] as const;
export const GOVT_SOURCE = ["Manual", "Portal Sync"] as const;
export const PENDING_DONE = ["Pending", "Completed"] as const;
export const INVOICE_STATUS = ["Not Ready", "Ready", "Raised", "Paid"] as const;
export const SYNC_FREQUENCY = ["Daily", "Manual only"] as const;
export const SYNC_STATUS = ["OK", "Failed", "Partial"] as const;
export const SHEET_CHANGE_STATUS = ["Open", "Actioned", "Ignored"] as const;
export const SHEET_CHANGE_ACTION = ["No action", "Update target", "Start location", "Put on hold", "Stop location", "Close location"] as const;
export const FOLLOWUP_TYPE = ["Stop batch", "Release trainer", "Cancel trainer request", "Return candidates to pool", "Review target"] as const;
export const FOLLOWUP_STATUS = ["Pending", "Done", "Skipped"] as const;
export const USER_ROLE = ["Admin", "Operations", "Location", "Enrollment"] as const;
export const ACTOR_TYPE = ["USER", "SYSTEM", "AUTOMATION", "EXTERNAL_SYNC"] as const;

const oid = (ref: string, required = false) => ({ type: Schema.Types.ObjectId, ref, required });

// ---------- Program ----------
const ProgramSchema = new Schema({
  code: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true },
  duration_days: { type: Number, required: true, default: 15 },
  buffer_days: { type: Number, required: true, default: 5 },
  default_batch_size: { type: Number, required: true, default: 30 },
  requires_lab: { type: Boolean, default: false },
  trainer_skill: { type: String, required: true },
  completion_deadline_days: { type: Number, required: true, default: 90 },
  // plan1.md resolution #2: operating days (0=Sun..6=Sat) so Sundays don't raise fake missing-log alerts
  operating_days: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
  active: { type: Boolean, default: true },
}, { timestamps: true });

// ---------- Location ----------
const LocationSchema = new Schema({
  code: { type: String, required: true, unique: true, trim: true },
  external_id: { type: String },
  name: { type: String, required: true },
  city: String, state: String, address: String,
  approval_status: { type: String, enum: APPROVAL_STATUS, required: true, default: "Pending" },
  operational_status: { type: String, enum: OPERATIONAL_STATUS, required: true, default: "Not Started" },
  status_reason: String,
  status_changed_on: Date,
  spoc_name: String, spoc_phone: String, spoc_user: oid("User"),
  principal_name: String, principal_phone: String, principal_user: oid("User"),
}, { timestamps: true });

// ---------- LocationTarget ----------
const LocationTargetSchema = new Schema({
  location: oid("Location", true),
  program: oid("Program", true),
  approved_target: { type: Number, required: true },
  allocated_target: Number,
  start_date: Date, end_date: Date,
}, { timestamps: true });
LocationTargetSchema.index({ location: 1, program: 1 }, { unique: true });

// ---------- Room ----------
const RoomSchema = new Schema({
  location: oid("Location", true),
  name: { type: String, required: true },
  type: { type: String, enum: ROOM_TYPE, required: true },
  capacity: Number,
  active: { type: Boolean, default: true },
}, { timestamps: true });

// ---------- Trainer ----------
const TrainerSchema = new Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: String,
  skills: { type: [String], required: true },
  home_location: oid("Location"),
  status: { type: String, enum: TRAINER_STATUS, required: true, default: "Available" },
  available_from: Date,
  day_rate: Number,
  incentive_note: String,
  max_concurrent_batches: { type: Number, required: true, default: 5 }, // RPL M5: up to 5 batches per trainer
  active: { type: Boolean, default: true },
}, { timestamps: true });

// ---------- TrainerRequest ----------
const TrainerRequestSchema = new Schema({
  location: oid("Location", true),
  program: oid("Program", true),
  required_by_date: { type: Date, required: true },
  status: { type: String, enum: TRAINER_REQUEST_STATUS, required: true, default: "Open" },
  hiring_target_date: Date, tot_scheduled_on: Date, tot_done_on: Date,
  expected_available_from: Date,
  fulfilled_by_trainer: oid("Trainer"),
  raised_by: oid("User"),
  note: String,
}, { timestamps: true });

// ---------- Candidate ----------
const CandidateSchema = new Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  alt_phone: String, gender: String,
  dob: Date,            // RPL M8: name+DOB is the second duplicate-match key
  id_reference: String, // government ID reference (NOT the Aadhaar number itself)
  location: oid("Location", true),
  program: oid("Program", true),
  source: String,
  lifecycle_status: { type: String, enum: LIFECYCLE_STATUS, required: true, default: "Unassigned" },
  created_by: oid("User"),
}, { timestamps: true });

// ---------- Batch ----------
const BatchSchema = new Schema({
  code: { type: String, required: true, unique: true },
  location: oid("Location", true),
  program: oid("Program", true),
  trainer: oid("Trainer"),
  room: oid("Room"),
  session: { type: String, enum: BATCH_SESSION, default: "Full Day" },
  target_size: { type: Number, required: true },
  planned_start: { type: Date, required: true },
  planned_end: Date,
  actual_start: Date, actual_end: Date,
  status: { type: String, enum: BATCH_STATUS, required: true, default: "Planning" },
  cancel_reason: String,
  created_by: oid("User"),
}, { timestamps: true });

// ---------- BatchMember (the roster) ----------
const BatchMemberSchema = new Schema({
  batch: oid("Batch", true),
  candidate: oid("Candidate", true),
  joined_on: { type: Date, required: true },
  left_on: { type: Date, default: null },
  drop_reason: String,
  enrollment_status: { type: String, enum: ENROLLMENT_STATUS, required: true, default: "Not Started" },
  reg_done: { type: Boolean, default: false }, reg_done_at: Date,
  kyc_done: { type: Boolean, default: false }, kyc_done_at: Date,
  accept_done: { type: Boolean, default: false }, accept_done_at: Date,
  issue: { type: String, enum: [...ENROLLMENT_ISSUE, null], default: null },
  issue_note: String,
  source: { type: String, enum: MEMBER_SOURCE, required: true, default: "Manual" },
}, { timestamps: true });
BatchMemberSchema.index({ batch: 1, candidate: 1 }, { unique: true });
// Rule 20 support: one active membership per candidate (partial unique on left_on null)
BatchMemberSchema.index({ candidate: 1 }, { unique: true, partialFilterExpression: { left_on: null } });

// ---------- DailyLog ----------
const DailyLogSchema = new Schema({
  batch: oid("Batch", true),
  log_date: { type: Date, required: true },
  planned_topic: String, actual_topic: String,
  present_member_ids: { type: [Schema.Types.ObjectId], default: [] },
  internal_present: { type: Number, required: true },
  roster_count: { type: Number, required: true }, // frozen at save (Rule 28)
  govt_present: { type: Number, default: null },
  govt_source: { type: String, enum: GOVT_SOURCE, default: "Manual" },
  govt_screenshot: String,
  photos: { type: [String], default: [] },
  videos: { type: [String], default: [] },
  note: String,
  entered_by: oid("User", true),
  entered_at: { type: Date, required: true, default: () => new Date() },
}, { timestamps: true });
DailyLogSchema.index({ batch: 1, log_date: 1 }, { unique: true });

// ---------- Closure ----------
const ClosureSchema = new Schema({
  batch: { ...oid("Batch", true), unique: true },
  assessment_status: { type: String, enum: PENDING_DONE, default: "Pending" },
  assessment_date: Date, appeared: Number, passed: Number, result_file: String,
  certification_status: { type: String, enum: PENDING_DONE, default: "Pending" },
  certification_date: Date, certificates_issued: Number, certificate_file: String,
  ready_for_invoice: { type: Boolean, default: false },
  marked_ready_by: oid("User"), marked_ready_at: Date,
}, { timestamps: true });

// ---------- CandidateResult (RPL M17 + M18) — one row per candidate per batch ----------
// A separate collection, not fields on BatchMember: it keeps "this batch has never used
// per-candidate marking" a single cheap predicate (row count === 0), which is the whole
// legacy/back-compat strategy, and makes rollback a collection drop.
const CandidateResultSchema = new Schema({
  batch: oid("Batch", true),
  candidate: oid("Candidate", true),
  batch_member: oid("BatchMember", true),

  // M17 — assessment
  result: { type: String, enum: ASSESSMENT_RESULT, default: "Pending" },
  score: Number,
  max_score: { type: Number, default: 100 },
  assessed_on: Date,
  assessor: String,
  failure_reason: String,
  failure_note: String,
  reassessment_required: { type: Boolean, default: false },
  reassessment_date: Date,
  evidence_file: String,
  attempt: { type: Number, default: 1 },
  attempts: [{
    attempt: Number, result: String, score: Number, assessed_on: Date, assessor: String,
    failure_reason: String, evidence_file: String, recorded_by: oid("User"), recorded_at: Date,
  }],

  // M18 — certification
  certificate_status: { type: String, enum: CERTIFICATE_STATUS, default: "Pending" },
  certificate_no: String,
  certificate_date: Date,
  certificate_file: String,
  certificate_rejection_reason: String,

  marked_by: oid("User"), marked_at: Date,
  source: { type: String, enum: MEMBER_SOURCE, default: "Manual" }, // §7 provenance
}, { timestamps: true });
CandidateResultSchema.index({ batch: 1, candidate: 1 }, { unique: true });
CandidateResultSchema.index({ candidate: 1, createdAt: -1 });
// Partial index: only rows that actually carry a number participate, so blank rows never collide.
CandidateResultSchema.index({ certificate_no: 1 }, { unique: true, partialFilterExpression: { certificate_no: { $type: "string" } } });

// ---------- Invoice ----------
const InvoiceSchema = new Schema({
  batch: { ...oid("Batch", true), unique: true },
  amount: Number,
  status: { type: String, enum: INVOICE_STATUS, required: true, default: "Not Ready" },
  invoice_no: String, raised_on: Date, paid_on: Date, file: String,
}, { timestamps: true });

// ---------- CostEntry ----------
const CostEntrySchema = new Schema({
  entry_date: { type: Date, required: true },
  location: oid("Location"), batch: oid("Batch"), trainer: oid("Trainer"),
  category: oid("CostCategory", true),
  amount: { type: Number, required: true },
  note: String,
  entered_by: oid("User", true),
}, { timestamps: true });

// ---------- SyncSource ----------
const SyncSourceSchema = new Schema({
  name: { type: String, required: true },
  source_url: { type: String, required: true },
  sync_time: String,
  frequency: { type: String, enum: SYNC_FREQUENCY, default: "Manual only" },
  last_synced_at: Date,
  last_status: { type: String, enum: SYNC_STATUS },
  last_error: String,
  field_mappings: { type: Schema.Types.Mixed, default: {} }, // external_column -> erp_field
}, { timestamps: true });

// ---------- SheetChange ----------
const SheetChangeSchema = new Schema({
  sync_source: oid("SyncSource", true),
  location: oid("Location"),
  field_name: { type: String, required: true },
  old_value: String, new_value: String,
  detected_at: { type: Date, required: true, default: () => new Date() },
  status: { type: String, enum: SHEET_CHANGE_STATUS, required: true, default: "Open" },
  impact_snapshot: Schema.Types.Mixed,
  action_taken: { type: String, enum: [...SHEET_CHANGE_ACTION, null], default: null },
  note: String,
  actor: oid("User"), actioned_at: Date,
}, { timestamps: true });

// ---------- FollowUpAction ----------
const FollowUpActionSchema = new Schema({
  source_change: oid("SheetChange", true),
  type: { type: String, enum: FOLLOWUP_TYPE, required: true },
  target_entity: String,
  target_id: Schema.Types.ObjectId,
  status: { type: String, enum: FOLLOWUP_STATUS, required: true, default: "Pending" },
  owner: oid("User"), due_date: Date,
  completed_by: oid("User"), completed_at: Date,
}, { timestamps: true });

// ---------- Notification (RPL M22) ----------
export const NOTIFICATION_STATUS = ["New", "Acknowledged", "Resolved"] as const;
export const NOTIFICATION_SEVERITY = ["info", "warning", "critical"] as const;

const NotificationSchema = new Schema({
  type: { type: String, required: true },      // stable key, e.g. "sheet_change_stale"
  severity: { type: String, enum: NOTIFICATION_SEVERITY, default: "warning" },
  message: { type: String, required: true },
  entity: String, entity_id: Schema.Types.ObjectId,
  link: String,                                 // where the user should go to act
  role_target: [{ type: String, enum: USER_ROLE }],
  location: oid("Location"),                    // for Rule 38 scoping
  due_at: Date,
  status: { type: String, enum: NOTIFICATION_STATUS, required: true, default: "New" },
  acknowledged_by: oid("User"), acknowledged_at: Date,
}, { timestamps: true });
// One live alert per condition per entity — the scheduler re-runs every few minutes and
// must not create a duplicate each time.
NotificationSchema.index({ type: 1, entity_id: 1, status: 1 });
NotificationSchema.index({ status: 1, createdAt: -1 });

// ---------- User ----------
const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password_hash: { type: String, required: true },
  role: { type: String, enum: USER_ROLE, required: true },
  location_scope: [{ type: Schema.Types.ObjectId, ref: "Location" }],
  can_edit: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
}, { timestamps: true });

// ---------- AuditLog ----------
const AuditLogSchema = new Schema({
  entity: { type: String, required: true },
  entity_id: { type: Schema.Types.ObjectId, required: true },
  field: String,
  old_value: Schema.Types.Mixed, new_value: Schema.Types.Mixed,
  actor: oid("User"),
  actor_type: { type: String, enum: ACTOR_TYPE, required: true, default: "USER" },
}, { timestamps: { createdAt: "created_at", updatedAt: false } });
AuditLogSchema.index({ entity: 1, entity_id: 1, created_at: -1 });

// ---------- Master lists ----------
const NamedActiveSchema = new Schema({
  name: { type: String, required: true, unique: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });

// ---------- Defaults (Admin → Defaults, §8; single doc keyed by _singleton) ----------
const DefaultsSchema = new Schema({
  _singleton: { type: String, default: "defaults", unique: true },
  batch_size: { type: Number, default: 30 },
  duration_days: { type: Number, default: 15 },
  buffer_days: { type: Number, default: 5 },
  completion_deadline_days: { type: Number, default: 90 },
  mobilisation_lead_days: { type: Number, default: 7 },
  attendance_gap_amber: { type: Number, default: 5 },
  attendance_gap_red: { type: Number, default: 10 },
  daily_log_edit_window_hours: { type: Number, default: 48 },
  max_concurrent_batches: { type: Number, default: 5 },
  roster_threshold_pct: { type: Number, default: 80 }, // Rule 16: roster ≥ this % of target_size
  // plan1.md resolution #1: Ready → Active additionally requires this % of roster enrolled
  enrollment_threshold_pct: { type: Number, default: 80 },
});

export type Id = Types.ObjectId;

export const Program = models.Program || model("Program", ProgramSchema);
export const Location = models.Location || model("Location", LocationSchema);
export const LocationTarget = models.LocationTarget || model("LocationTarget", LocationTargetSchema);
export const Room = models.Room || model("Room", RoomSchema);
export const Trainer = models.Trainer || model("Trainer", TrainerSchema);
export const TrainerRequest = models.TrainerRequest || model("TrainerRequest", TrainerRequestSchema);
export const Candidate = models.Candidate || model("Candidate", CandidateSchema);
export const Batch = models.Batch || model("Batch", BatchSchema);
export const BatchMember = models.BatchMember || model("BatchMember", BatchMemberSchema);
export const DailyLog = models.DailyLog || model("DailyLog", DailyLogSchema);
export const Closure = models.Closure || model("Closure", ClosureSchema);
export const CandidateResult = models.CandidateResult || model("CandidateResult", CandidateResultSchema);
export const Invoice = models.Invoice || model("Invoice", InvoiceSchema);
export const CostEntry = models.CostEntry || model("CostEntry", CostEntrySchema);
export const SyncSource = models.SyncSource || model("SyncSource", SyncSourceSchema);
export const SheetChange = models.SheetChange || model("SheetChange", SheetChangeSchema);
export const FollowUpAction = models.FollowUpAction || model("FollowUpAction", FollowUpActionSchema);
export const User = models.User || model("User", UserSchema);
export const Notification = models.Notification || model("Notification", NotificationSchema);
export const AuditLog = models.AuditLog || model("AuditLog", AuditLogSchema);
export const CostCategory = models.CostCategory || model("CostCategory", NamedActiveSchema);
export const DropReason = models.DropReason || model("DropReason", (NamedActiveSchema as any).clone?.() ?? NamedActiveSchema);
export const FailureReason = models.FailureReason || model("FailureReason", (NamedActiveSchema as any).clone?.() ?? NamedActiveSchema);
export const Defaults = models.Defaults || model("Defaults", DefaultsSchema);

export { mongoose };
