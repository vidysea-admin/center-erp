import mongoose, { Schema, model, models, Types } from "mongoose";

// Enums (locked v1 — center-erp-data-model-rules.md §2)
export const APPROVAL_STATUS = ["Pending", "Approved", "Rejected"] as const;
export const OPERATIONAL_STATUS = ["Not Started", "Active", "On Hold", "Stopped", "Closed"] as const;
export const ROOM_TYPE = ["Classroom", "Lab"] as const;
export const TRAINER_STATUS = ["Available", "Assigned", "Unavailable"] as const;
// 2026-08-11 meeting: "application pool से चालू होगा… ready to train वाला status आना चाहिए" —
// the hiring journey, separate from the derived operational status above (Rule 12).
export const TRAINER_PIPELINE = ["Applied", "Shortlisted", "TOT In Progress", "Ready to Train"] as const;
// CEO named four: "एक तो बैच वाइज पैसे देते हैं, एक किसी को मंथली देते हैं… एक तो हो गया
// फिक्स, और एक होता है इंसेंटिव बेस्ड ऑन देयर परफॉरमेंस". Only two were selectable (2026-08-12).
export const COMPENSATION_TYPE = ["Batch-wise", "Monthly", "Fixed", "Incentive-based"] as const;
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
// "Trainer" added 2026-08-11 (CEO): trainers sign up themselves, choose the role, and wait
// for Admin approval. A trainer login is scoped to the batches they teach.
export const USER_ROLE = ["Admin", "Operations", "Location", "Enrollment", "Trainer"] as const;
export const USER_APPROVAL = ["Pending", "Approved", "Rejected"] as const;
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
  // 2026-08-11 meeting: "एक SPOC, दो SPOC… कोई और contact person है तो वो सब ऐड कर पाऊं" —
  // any number of named contacts beyond the two legacy slots above (which stay untouched).
  contacts: [{
    name: { type: String, required: true },
    phone: String,
    role_label: { type: String, default: "Contact" }, // SPOC / Principal / Cluster Head / Contact…
    user: oid("User"),
  }],
}, { timestamps: true });

// ---------- MeetingNote (2026-08-11 meeting) ----------
// "मीटिंग के नोट्स ले पाऊं… ताकि मुझे पता रहे किससे किस लोकेशन पे किस दिन बात हुई है" —
// so the boss and Manish stay on the same page about every location conversation.
const MeetingNoteSchema = new Schema({
  location: oid("Location", true),
  meeting_date: { type: Date, required: true, default: () => new Date() },
  met_with: String,                 // who the conversation was with
  note: { type: String, required: true },
  logged_by: oid("User", true),
}, { timestamps: true });
MeetingNoteSchema.index({ location: 1, meeting_date: -1 });

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
  // Hiring pipeline (2026-08-11). Existing trainers predate the pipeline — they default to
  // Ready to Train so nothing operational changes for them.
  pipeline_status: { type: String, enum: TRAINER_PIPELINE, default: "Ready to Train" },
  tr_id: String, // NSDC TR ID, assigned after TOT certification
  govt_candidate_id: String, // portal "Candidate ID" (CAN_…) — trainers appear on the attendance export too
  user: oid("User"), // linked login (2026-08-11: trainers sign up and get approved)
  capable_locations: [{ type: Schema.Types.ObjectId, ref: "Location" }], // "कहां-कहां training ले सकता है" — 1, 2 or 10
  programs_applied: [{ type: Schema.Types.ObjectId, ref: "Program" }],
  available_from: Date,
  day_rate: Number,
  incentive_note: String, // incentive based on performance — free text until the formula is defined
  compensation_type: { type: String, enum: COMPENSATION_TYPE },
  compensation_fixed: Number, // the fixed component (per batch or per month, per compensation_type)
  max_concurrent_batches: { type: Number, required: true, default: 4 }, // 2026-08-11: "up to four batches का provision" (was RPL M5's 5)
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
// 2026-08-11 meeting: eligibility criteria (age 18–40, 10th pass, no training in the last
// 6 months), interest capture, and the SIDH registration stage — a candidate stage, not a
// batch step ("हमें बच्चा जब हमारे पास आया, तभी से registration process चालू").
export const EDUCATION_LEVEL = ["Below 10th", "10th Pass", "12th Pass", "Graduate", "Post Graduate"] as const;
export const SIDH_STATUS = ["Not Registered", "Link Sent", "Registered"] as const;
const CandidateSchema = new Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  alt_phone: String, gender: String,
  dob: Date,            // RPL M8: name+DOB is the second duplicate-match key
  id_reference: String, // government ID reference (NOT the Aadhaar number itself)
  location: oid("Location", true),
  program: oid("Program", true),
  source: String,
  education: { type: String, enum: [...EDUCATION_LEVEL, null], default: null },
  last_training_date: Date, // "last training कब हुई वो date ले लो" — eligibility flips when the cooldown lapses
  interested_programs: [{ type: Schema.Types.ObjectId, ref: "Program" }],
  interested_locations: [{ type: Schema.Types.ObjectId, ref: "Location" }],
  sidh_status: { type: String, enum: SIDH_STATUS, default: "Not Registered" },
  sidh_link_sent_at: Date,
  sidh_registered_on: Date,
  // Portal "Candidate ID" (CAN_40918461). The government attendance export keys on this, so it
  // is the only reliable join — names repeat within a centre.
  sidh_candidate_id: { type: String, default: null },
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
  // 2026-08-11 meeting: a trainer runs up to 4 parallel batches with the day divided by time
  // ("7 से 11, 12 से 4, 5 से 9"). Optional "HH:mm" pair; when both batches carry slots, a
  // same-time overlap for one trainer is hard-blocked.
  slot_start: String, slot_end: String,
  target_size: { type: Number, required: true },
  planned_start: { type: Date, required: true },
  planned_end: Date,
  actual_start: Date, actual_end: Date,
  status: { type: String, enum: BATCH_STATUS, required: true, default: "Planning" },
  // Backward planner (2026-08-11): milestone dates computed back from planned_start with
  // configurable lead times, each tick-off-able. Regenerable while the batch is in Planning.
  milestones: [{
    key: String, label: String,
    due_date: Date,
    done_on: Date, done_by: oid("User"),
  }],
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

// ---------- Government portal attendance (2026-08-12) ----------
// The portal exports a cumulative per-person summary, not a day-wise register, so it cannot be
// folded into DailyLog.govt_present (which is per day). It is kept as its own immutable import
// record: the file as received, plus what each row matched to and how far it diverges from the
// centre's own logs. Re-importing a newer file creates a NEW import — history is never rewritten,
// because the client contract is settled against whatever the portal said on a given date.
export const GOVT_MATCH_STATUS = ["Matched", "Ambiguous", "Unmatched"] as const;
const GovtAttendanceImportSchema = new Schema({
  location: oid("Location"),
  batch: oid("Batch"),          // optional: an import can cover a whole centre
  file_name: String,
  org_name: String,
  tc_id: String,
  period_label: String,         // e.g. "till 11 Aug" — operator-supplied, the portal does not carry it
  row_count: { type: Number, default: 0 },
  matched_count: { type: Number, default: 0 },
  unmatched_count: { type: Number, default: 0 },
  ambiguous_count: { type: Number, default: 0 },
  variance_count: { type: Number, default: 0 }, // rows where portal days ≠ our logged days
  imported_by: oid("User"),
  imported_at: { type: Date, default: () => new Date() },
}, { timestamps: true });

const GovtAttendanceRowSchema = new Schema({
  import: oid("GovtAttendanceImport", true),
  location: oid("Location"),
  batch: oid("Batch"),
  candidate: oid("Candidate"),
  trainer: oid("Trainer"),
  batch_member: oid("BatchMember"),
  // as received from the portal
  sl_no: Number,
  org_name: String, tc_id: String, attendance_id: String,
  name: String,
  govt_candidate_id: String,
  candidate_type: String, designation: String,
  total_working_days: Number,
  total_days_present: Number,
  total_hours_minutes: Number, total_hours_raw: String,
  average_per_day_raw: String,
  not_closed: Number,
  // reconciliation
  match_status: { type: String, enum: GOVT_MATCH_STATUS, default: "Unmatched" },
  match_by: String, match_note: String,
  internal_days_present: { type: Number, default: null },
  variance_days: { type: Number, default: null },
}, { timestamps: true });
GovtAttendanceRowSchema.index({ import: 1 });
GovtAttendanceRowSchema.index({ candidate: 1, createdAt: -1 });

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
// mode "mapped": the original Location-field sync (Rules 1–9).
// mode "watch": 2026-08-11 meeting — snapshot EVERY tab and column of the client's live
// workbook on an interval, and surface every cell change; nothing is written to ERP entities.
export const SYNC_MODE = ["mapped", "watch"] as const;
const SyncSourceSchema = new Schema({
  name: { type: String, required: true },
  source_url: { type: String, required: true },
  sync_time: String,
  frequency: { type: String, enum: SYNC_FREQUENCY, default: "Manual only" },
  mode: { type: String, enum: SYNC_MODE, default: "mapped" },
  interval_minutes: { type: Number, default: 30 },      // watch mode: poll cadence
  key_columns: { type: [String], default: [] },          // watch mode: row identity (e.g. Institution Name + Job role)
  last_synced_at: Date,
  last_status: { type: String, enum: SYNC_STATUS },
  last_error: String,
  // 2026-08-12: pause a source without deleting it — a sheet the client has stopped updating
  // should not keep raising failures, but its history is still worth keeping.
  active: { type: Boolean, default: true },
  field_mappings: { type: Schema.Types.Mixed, default: {} }, // external_column -> erp_field (mapped mode)
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

// ---------- Workbook Watch (2026-08-11 meeting) ----------
// The client edits their sheet in place and tells nobody. Every `interval_minutes` the full
// workbook is snapshotted; each cell that differs from the previous snapshot becomes a
// WorkbookChange the team reviews. Advisory only — accepting a change never writes to ERP
// entities (that stays with the mapped sync / manual edits).
export const WORKBOOK_CHANGE_TYPE = ["Added", "Removed", "Modified"] as const;
export const WORKBOOK_CHANGE_STATUS = ["New", "Seen", "Accepted"] as const;

const WorkbookSnapshotSchema = new Schema({
  sync_source: oid("SyncSource", true),
  tab: { type: String, required: true },
  header: { type: [String], default: [] },     // detected header row
  header_row: { type: Number, default: 0 },    // its index in the raw sheet
  rows: { type: Schema.Types.Mixed, default: [] }, // array of {key, cells: {col: value}}
  hash: String,                                 // content hash — unchanged tab ⇒ no diff walk
  taken_at: { type: Date, required: true, default: () => new Date() },
});
WorkbookSnapshotSchema.index({ sync_source: 1, tab: 1, taken_at: -1 });

const WorkbookChangeSchema = new Schema({
  sync_source: oid("SyncSource", true),
  tab: { type: String, required: true },
  row_key: { type: String, required: true },   // key_columns values joined, else row #
  column: String,                               // null for whole-row Added/Removed
  old_value: String, new_value: String,
  change_type: { type: String, enum: WORKBOOK_CHANGE_TYPE, required: true },
  status: { type: String, enum: WORKBOOK_CHANGE_STATUS, required: true, default: "New" },
  detected_at: { type: Date, required: true, default: () => new Date() },
  actor: oid("User"), actioned_at: Date,
}, { timestamps: true });
WorkbookChangeSchema.index({ sync_source: 1, status: 1, detected_at: -1 });
WorkbookChangeSchema.index({ tab: 1, row_key: 1, column: 1, status: 1 });

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

// ---------- Approval matrix (RPL M24 cross-cutting) ----------
// One reusable pair of entities referenced by every gated action, rather than an approval
// flow rebuilt per module. Ships switched OFF: with no enabled rule nothing changes.
export const APPROVAL_ACTIONS = [
  "location.close", "location.stop", "batch.cancel", "invoice.raise", "invoice.paid", "batch.complete",
] as const;
export const APPROVAL_REQUEST_STATUS = ["Pending", "Approved", "Rejected", "Cancelled"] as const;

const ApprovalRuleSchema = new Schema({
  action: { type: String, enum: APPROVAL_ACTIONS, required: true, unique: true },
  enabled: { type: Boolean, default: false },
  approver_role: { type: String, enum: USER_ROLE, default: "Admin" },
  note: String,
}, { timestamps: true });

const ApprovalRequestSchema = new Schema({
  action: { type: String, enum: APPROVAL_ACTIONS, required: true },
  entity: String, entity_id: Schema.Types.ObjectId,
  summary: { type: String, required: true },   // human-readable "what is being asked"
  payload: Schema.Types.Mixed,                 // replayed verbatim once approved
  location: oid("Location"),
  initiator: oid("User", true),
  approver_role: { type: String, enum: USER_ROLE, required: true },
  status: { type: String, enum: APPROVAL_REQUEST_STATUS, required: true, default: "Pending" },
  decided_by: oid("User"), decided_at: Date, decision_note: String,
}, { timestamps: true });
ApprovalRequestSchema.index({ status: 1, approver_role: 1, createdAt: -1 });

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

// ---------- Public tokens (2026-08-11: self-registration + candidate feedback) ----------
// Capability URLs: the random token IS the credential. register tokens are per-location
// (Admin/Ops generate and share); feedback tokens are per batch-member.
export const PUBLIC_TOKEN_PURPOSE = ["register", "feedback"] as const;
const PublicTokenSchema = new Schema({
  token: { type: String, required: true, unique: true },
  purpose: { type: String, enum: PUBLIC_TOKEN_PURPOSE, required: true },
  location: oid("Location"),    // register: which location's pool the candidate lands in
  program: oid("Program"),      // register: optional preselected program
  batch_member: oid("BatchMember"), // feedback: who this link belongs to
  active: { type: Boolean, default: true },
  created_by: oid("User"),
}, { timestamps: true });
PublicTokenSchema.index({ purpose: 1, location: 1 });
PublicTokenSchema.index({ purpose: 1, batch_member: 1 });

// ---------- Feedback (2026-08-11: "हर बच्चा… feedback दे पाए") ----------
const FeedbackSchema = new Schema({
  batch: oid("Batch", true),
  batch_member: oid("BatchMember", true),
  rating: { type: Number, min: 1, max: 5, required: true },
  liked: String,        // what was good
  suggestions: String,  // "कुछ सुझाव है, सुझाव दे पाए"
  submitted_at: { type: Date, default: () => new Date() },
}, { timestamps: true });
FeedbackSchema.index({ batch_member: 1 }, { unique: true }); // one response per member

// ---------- User ----------
const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: String,
  password_hash: { type: String, required: true },
  role: { type: String, enum: USER_ROLE, required: true },
  location_scope: [{ type: Schema.Types.ObjectId, ref: "Location" }],
  can_edit: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  // 2026-08-11 (CEO): self-signup lands here as Pending with a requested role; only an
  // Admin approval activates the account. Existing users default to Approved.
  approval_status: { type: String, enum: USER_APPROVAL, default: "Approved" },
  requested_role: { type: String, enum: USER_ROLE },
  approved_by: oid("User"), approved_at: Date,
  // 2026-08-11 (CEO): special per-user grants on top of the role's toggled set —
  // "किसी को special देने तो admin दे पाएगा"
  extra_permissions: { type: [String], default: [] },
}, { timestamps: true });

// ---------- RolePermission (2026-08-11, CEO: AWS-style group toggles) ----------
// One document per role = the "group". Admin toggles which feature-rights the role carries;
// enforcement = role's toggled set ∪ the user's extra_permissions (Admin bypasses all).
const RolePermissionSchema = new Schema({
  role: { type: String, enum: USER_ROLE, required: true, unique: true },
  permissions: { type: [String], default: [] },
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
  max_concurrent_batches: { type: Number, default: 4 }, // 2026-08-11: cap 4 (was RPL M5's 5)
  roster_threshold_pct: { type: Number, default: 80 }, // Rule 16: roster ≥ this % of target_size
  // plan1.md resolution #1: Ready → Active additionally requires this % of roster enrolled
  enrollment_threshold_pct: { type: Number, default: 80 },
  // Candidate eligibility (2026-08-11)
  min_age: { type: Number, default: 18 },
  max_age: { type: Number, default: 40 },
  training_cooldown_months: { type: Number, default: 6 },
  // Backward batch planner lead times (2026-08-11)
  lead_enrollment_days: { type: Number, default: 1 },
  lead_mobilization_days: { type: Number, default: 2 },
  lead_trainer_ready_days: { type: Number, default: 1 },
  lead_tot_done_days: { type: Number, default: 3 },
  lead_tot_start_days: { type: Number, default: 10 },
  lead_trainer_ready_for_tot_days: { type: Number, default: 15 },
  lead_trainer_found_days: { type: Number, default: 20 },
  min_daily_evidence: { type: Number, default: 2 },
  sidh_url: { type: String, default: "https://www.skillindiadigital.gov.in/" },
  // Scheme timing guidelines, confirmed by Manish 2026-08-12: the training day runs 9 to 6; a
  // session may be up to 4 hours; two 4-hour batches a day is the sanctioned pattern (three
  // 3-hour batches was asked for and refused); no minimum break is prescribed.
  day_start_time: { type: String, default: "09:00" },
  day_end_time: { type: String, default: "18:00" },
  max_session_hours: { type: Number, default: 4 },
  max_batches_per_day: { type: Number, default: 2 },
  // Client-contract counting rules, confirmed by Manish 2026-08-12.
  // "Appeared" is NOT reduced by absentees — the client counts everyone who reached assessment
  // stage. Kept as a toggle because it is a contract term, not a scheme rule, and the next
  // client may well count the other way.
  absent_counts_as_appeared: { type: Boolean, default: true },
  // A candidate who dropped out is not billable even if they passed.
  dropped_pass_is_billable: { type: Boolean, default: false },
  // Evidence uploads: 25 MB was too small for the twice-daily videos. Configurable so the
  // ceiling can be tuned against the server's disk without a deploy.
  max_upload_mb: { type: Number, default: 100 },
});

export type Id = Types.ObjectId;

export const Program = models.Program || model("Program", ProgramSchema);
export const Location = models.Location || model("Location", LocationSchema);
export const MeetingNote = models.MeetingNote || model("MeetingNote", MeetingNoteSchema);
export const LocationTarget = models.LocationTarget || model("LocationTarget", LocationTargetSchema);
export const Room = models.Room || model("Room", RoomSchema);
export const Trainer = models.Trainer || model("Trainer", TrainerSchema);
export const TrainerRequest = models.TrainerRequest || model("TrainerRequest", TrainerRequestSchema);
export const Candidate = models.Candidate || model("Candidate", CandidateSchema);
export const Batch = models.Batch || model("Batch", BatchSchema);
export const BatchMember = models.BatchMember || model("BatchMember", BatchMemberSchema);
export const DailyLog = models.DailyLog || model("DailyLog", DailyLogSchema);
export const GovtAttendanceImport = models.GovtAttendanceImport || model("GovtAttendanceImport", GovtAttendanceImportSchema);
export const GovtAttendanceRow = models.GovtAttendanceRow || model("GovtAttendanceRow", GovtAttendanceRowSchema);
export const Closure = models.Closure || model("Closure", ClosureSchema);
export const CandidateResult = models.CandidateResult || model("CandidateResult", CandidateResultSchema);
export const Invoice = models.Invoice || model("Invoice", InvoiceSchema);
export const CostEntry = models.CostEntry || model("CostEntry", CostEntrySchema);
export const SyncSource = models.SyncSource || model("SyncSource", SyncSourceSchema);
export const SheetChange = models.SheetChange || model("SheetChange", SheetChangeSchema);
export const WorkbookSnapshot = models.WorkbookSnapshot || model("WorkbookSnapshot", WorkbookSnapshotSchema);
export const WorkbookChange = models.WorkbookChange || model("WorkbookChange", WorkbookChangeSchema);
export const PublicToken = models.PublicToken || model("PublicToken", PublicTokenSchema);
export const Feedback = models.Feedback || model("Feedback", FeedbackSchema);
export const FollowUpAction = models.FollowUpAction || model("FollowUpAction", FollowUpActionSchema);
export const User = models.User || model("User", UserSchema);
export const RolePermission = models.RolePermission || model("RolePermission", RolePermissionSchema);
export const Notification = models.Notification || model("Notification", NotificationSchema);
export const ApprovalRule = models.ApprovalRule || model("ApprovalRule", ApprovalRuleSchema);
export const ApprovalRequest = models.ApprovalRequest || model("ApprovalRequest", ApprovalRequestSchema);
export const AuditLog = models.AuditLog || model("AuditLog", AuditLogSchema);
export const CostCategory = models.CostCategory || model("CostCategory", NamedActiveSchema);
export const DropReason = models.DropReason || model("DropReason", (NamedActiveSchema as any).clone?.() ?? NamedActiveSchema);
export const FailureReason = models.FailureReason || model("FailureReason", (NamedActiveSchema as any).clone?.() ?? NamedActiveSchema);
export const Defaults = models.Defaults || model("Defaults", DefaultsSchema);

export { mongoose };
