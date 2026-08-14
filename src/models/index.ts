import mongoose, { Schema, model, models, Types } from "mongoose";

// Enums (locked v1 — center-erp-data-model-rules.md §2)
export const APPROVAL_STATUS = ["Pending", "Approved", "Rejected"] as const;
export const OPERATIONAL_STATUS = ["Not Started", "Active", "On Hold", "Stopped", "Closed"] as const;
export const ROOM_TYPE = ["Classroom", "Lab"] as const;
export const TRAINER_STATUS = ["Available", "Assigned", "Unavailable"] as const;
// 2026-08-11 meeting: "application pool से चालू होगा… ready to train वाला status आना चाहिए" —
// the hiring journey, separate from the derived operational status above (Rule 12).
//
// 2026-08-12 (Manish, RPL walkthrough): the four placeholder stages were nowhere near the real
// journey, which is a round-trip through an external body we do not control:
//   "CV आयी different sources से → review → देख रहे हमारे इन तीन job role में किस में fit बैठ रहा
//    है → documents मंगाये (आधार, PAN, photo, CV, educational qualification, CIPSA certificate) →
//    industry + teaching experience → nomination form भरते हैं → ABPL team अपनी email से NSDC को
//    submit करती है → approve होके आता है / profile में त्रुटि बतायी जाती है → correct करके वापस
//    भेजते हैं → eligible होने पर ₹3250 payment → TOT → certified → TR ID"
// "NSDC Rejected" is deliberately NOT terminal — the correct-and-resubmit loop is the common case,
// and the 2026-08-12 audit found an S0 exactly where a rejected certificate had no way back.
// 2026-08-14 (CEO via Umesh, twice): "CV Reviewed + Shortlisted (for TOT)" are ONE decision
// and "Docs Pending + Docs Complete" are ONE stage — merged. Old values remain accepted as
// import aliases and are remapped in prod by the 14/08 migration.
export const TRAINER_PIPELINE = [
  "Applied",
  "CV Reviewed",
  "Docs Pending",
  "Nomination Prepared",
  "Submitted to NSDC",
  "NSDC Approved",
  "NSDC Rejected",
  "Payment Done",
  "TOT Scheduled",
  "TOT In Progress",
  "Certified",
  "Dropped",
] as const;

// The documents Manish listed by name, plus the two experience certificates that are mandatory
// for TVP eligibility on some job roles.
export const TRAINER_DOC_TYPE = [
  "Aadhaar", "PAN", "Photo", "CV", "Educational Qualification",
  "CIPSA Certificate", "Industry Experience", "Teaching Experience", "Other",
] as const;

// The government schemes actually running, from the client's RPL workbook (2026-08-12).
// Priority is the CEO's: "पहले हमें ABPL, HSL दूसरे priority पे है, तीसरे पे ये है".
export const SCHEME = ["RPL-AVPL", "RPL-HSL", "PMKVY-BECIL", "DDU-GKY2.0", "DDUGKY 2.0 SPH"] as const;
// CEO named four: "एक तो बैच वाइज पैसे देते हैं, एक किसी को मंथली देते हैं… एक तो हो गया
// फिक्स, और एक होता है इंसेंटिव बेस्ड ऑन देयर परफॉरमेंस". Only two were selectable (2026-08-12).
export const COMPENSATION_TYPE = ["Batch-wise", "Monthly", "Fixed", "Incentive-based"] as const;
export const TRAINER_REQUEST_STATUS = ["Open", "In Progress", "Fulfilled", "Cancelled"] as const;
// "Not Certified" (RPL M17/M18): finished the batch but did not pass — not Completed
// (which would inflate outcome reporting) and not Dropped (they never left).
export const LIFECYCLE_STATUS = ["Unassigned", "Assigned", "Enrolled", "Dropped", "Completed", "Not Certified"] as const;
export const ASSESSMENT_RESULT = ["Pending", "Pass", "Fail", "Absent"] as const;
// "Not Issued" (2026-08-12 audit, S0): a terminal state for a Pass candidate the awarding body
// will never certify — name mismatch on the government ID, duplicate NSDC record, withdrawal.
// Without it, a Rejected certificate had no exit at all: reassessment refused, the result could
// not move off Pass, and the batch sat in Closing forever, so the only escape an operator could
// find was to invent a certificate number — which then counted in Closure.certificates_issued.
export const CERTIFICATE_STATUS = ["Pending", "Processing", "Generated", "Issued", "Rejected", "Not Issued"] as const;
export const BATCH_SESSION = ["Morning", "Afternoon", "Full Day"] as const;
// "Closed" added 2026-08-14 (Rule 52): Completed = training over; Closed = money over.
export const BATCH_STATUS = ["Planning", "Ready", "Active", "Closing", "Completed", "Closed", "Cancelled"] as const;
export const ENROLLMENT_STATUS = ["Not Started", "In Progress", "Completed", "Failed"] as const;
export const ENROLLMENT_ISSUE = ["OTP not received", "Already registered", "KYC failed", "Portal error", "Duplicate", "Other"] as const;
export const MEMBER_SOURCE = ["Manual", "Automation"] as const;
export const GOVT_SOURCE = ["Manual", "Portal Sync"] as const;
export const PENDING_DONE = ["Pending", "Completed"] as const;
export const INVOICE_STATUS = ["Not Ready", "Ready", "Raised", "Paid"] as const;
export const SYNC_FREQUENCY = ["Daily", "Manual only"] as const;
export const SYNC_STATUS = ["OK", "Failed", "Partial"] as const;
export const SHEET_CHANGE_STATUS = ["Open", "Actioned", "Ignored"] as const;
export const SHEET_CHANGE_ACTION = ["No action", "Update target", "Start location", "Put on hold", "Stop location", "Close location", "Apply value"] as const;
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
  // 2026-08-13 (Manish walkthrough): exam eligibility is hours-based — "120 mein se 60 ghante
  // attendance karenge tabhi qualify". QP-wise hours arrive with the real programme list
  // (H-PROGRAMMES); until set, readers derive duration_days × 8 (the full-day session length).
  hours: Number,
  buffer_days: { type: Number, required: true, default: 5 },
  default_batch_size: { type: Number, required: true, default: 30 },
  requires_lab: { type: Boolean, default: false },
  trainer_skill: { type: String, required: true },
  completion_deadline_days: { type: Number, required: true, default: 90 },
  // 2026-08-12 (Manish): a programme in this business is a JOB ROLE run under a SCHEME —
  // "HSL हमेशा solar है… ABPL RPL जहाँ लिखा होगा समझिये drone or battery है". The client's
  // workbook is one row per Institution × Scheme × Job role, so scheme belongs on the programme.
  // Without it the same job role under two schemes is indistinguishable, and nothing can be
  // reported or prioritised by scheme.
  scheme: { type: String, enum: SCHEME },
  qp_code: String,        // NSDC Qualification Pack, e.g. "ELE/Q4602"
  nsqf_level: Number,
  sector: String,
  // "पहले हमें ABPL, HSL दूसरे priority पे है, तीसरे पे ये है" — lower number = worked first.
  scheme_priority: { type: Number, default: 99 },
  // 2026-08-12 (Manish): "industry experience aur teaching experience required hai — mendetary
  // hai unko qualify karaane ke lie TVP mein jaane ke lie" — and it differs BY JOB ROLE. These
  // are IN ADDITION to the universal five (MANDATORY_TRAINER_DOCS); the union gates the
  // Docs Complete stage for trainers nominated to this job role.
  mandatory_trainer_docs: [{ type: String, enum: TRAINER_DOC_TYPE }],
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
  // 2026-08-12: the fields the client's RPL workbook actually carries for a centre. Without the
  // TC identity the ERP cannot say whether a centre is even able to enrol on the government
  // portal — "उस location के TC ID और password से login करूँगा और student का enrollment शुरू
  // कर दूँगा". tc_password is a live credential: it is masked for non-Admins exactly like the
  // Sheet Watch column already is (see src/app/api/workbook-changes/route.ts).
  district: String,
  tc_id: String,
  tc_password: String,
  tc_status: String,              // free text from the sheet ("Approved", blank, …)
  operating_partner: String,      // "Vidysea" / "Vidysea/RPTO" / "Vidysea/No Center"
  cluster_head_name: String,
  cluster_head_phone: String,
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
  // 2026-08-12: the client's sheet states how many trainers each centre×job-role needs
  // ("trainer कितने per location required है"). Requirement is stored; how many are actually
  // nominated or certified is DERIVED by counting Trainer rows, never stored — the two sheets
  // already disagree with each other (nominated 23 vs 20, certified 18 vs 16), which is exactly
  // what happens when a count is kept in more than one place.
  trainers_required: Number,
  // What the client's sheet CLAIMS, kept deliberately separate from what we compute, so a stale
  // or wrong figure from them can never overwrite our own enrolment number.
  enrolled_reported: Number,
  pending_reported: Number,
  reported_at: Date,
  // 2026-08-13 (Manish: "31 approved hain, 10 nahi"): the government approves each
  // centre×scheme×job-role ROW separately — each sheet row even carries its OWN TC ID
  // (Charthwal: TC353328 for AVPL, TC352938 for HSL). Centre-level Location.tc_status
  // stays as the fallback for pre-migration rows.
  tc_id: String,
  tc_status: String, // free text from the sheet ("Approved", blank, …)
  // 2026-08-13 (Karunn: "chaaron cheezein le lo, soft data ki tarah — hamare data ko hum
  // MATCH karenge"): the sheet's three CLAIMED trainer counts, enrolled_reported-pattern —
  // stored BESIDE our derived counts (trainerCountsFor), never merged, so claim-vs-ours
  // variance stays visible. Our figure remains derived from Trainer rows, never typed.
  nominations_received_reported: Number,
  nominated_nsdc_reported: Number,
  trainers_certified_reported: Number,
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
  // 2026-08-13 (Manish): "Others ka option bhi hona chahiye" — a trainer's home town is
  // usually NOT one of our centres. Free text used when home_location is unset.
  home_location_other: String,
  status: { type: String, enum: TRAINER_STATUS, required: true, default: "Available" },
  // Hiring pipeline (2026-08-11). Existing trainers predate the pipeline — they default to
  // Ready to Train so nothing operational changes for them.
  // Default is the START of the journey. It used to be the END ("Ready to Train") because the
  // placeholder pipeline had no real intake; with the real stages a new trainer is an applicant.
  pipeline_status: { type: String, enum: TRAINER_PIPELINE, default: "Applied" },
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

  // ---- 2026-08-12 (Manish): the hiring journey the ERP has to carry ----
  // Which vacancy this person is being put up for. The client's sheet counts trainers per
  // Institution × Scheme × Job role, so a nomination only means something against that pair.
  nominated_for_location: oid("Location"),
  nominated_for_program: oid("Program"),
  source: String,                       // "CV आयी different sources से" — referral, portal, agency…
  qualification: String,
  industry_experience_years: Number,    // required for some job roles before TVP will take them
  teaching_experience_years: Number,
  // The NSDC round-trip. ABPL submit from their own email, so we hold dates and their verdict,
  // not the submission itself: "approve होके आता है… profile में क्या त्रुटि है वो बताते हैं".
  nomination_sent_on: Date,
  nsdc_submitted_on: Date,
  nsdc_result_on: Date,
  nsdc_remarks: String,                 // why they were rejected — this is what gets corrected and resent
  // "eligible हो जाता है तब उसको हम 3250 rupee payment करने के लिए दे देंगे और TOT कराने के लिए"
  eligibility_payment_amount: { type: Number, default: 3250 },
  paid_on: Date,
  payment_reference: String,
  tot_scheduled_on: Date,
  tot_done_on: Date,
  tot_certificate_no: String,
  pipeline_note: String,
  dropped_reason: String,               // required to reach the terminal "Dropped" state
  dropped_from_stage: String,           // CEO: which stage the journey ended at ("Dropped at CV Reviewed")
}, { timestamps: true });
// 2026-08-12 audit: this schema declared NO indexes, so the same trainer could be created any
// number of times and a TR ID could be duplicated across people. A TR ID is issued by NSDC and
// is unique by definition; phone is how this team actually identifies a person.
TrainerSchema.index({ phone: 1 }, { unique: true });
TrainerSchema.index({ tr_id: 1 }, { unique: true, partialFilterExpression: { tr_id: { $type: "string" } } });

// ---------- TrainerDocument (2026-08-12) ----------
// "फिर उसके documents मंगाये — आधार, PAN, photo, CV, educational qualification, CIPSA certificate"
// There was no attachment model anywhere in the system; file URLs were ad-hoc string fields on a
// few other models. A trainer needs many documents, each separately verifiable, so this is a
// collection rather than an array — one row can be re-uploaded or rejected without touching the
// others, and the audit trail stays per-document.
const TrainerDocumentSchema = new Schema({
  trainer: oid("Trainer", true),
  doc_type: { type: String, enum: TRAINER_DOC_TYPE, required: true },
  file_url: { type: String, required: true },
  original_name: String,
  uploaded_by: oid("User"),
  verified: { type: Boolean, default: false },
  verified_by: oid("User"),
  verified_at: Date,
  note: String,
}, { timestamps: true });
TrainerDocumentSchema.index({ trainer: 1, doc_type: 1 });

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
// 2026-08-11 (GD-81): "registration ho hi nahi paya, to main time kyun waste karun… main bacche
// ko drop karke doosri queue mein dalunga" — a failed registration is its own state with its own
// queue, so nobody plans a batch around a candidate the portal will not take.
export const SIDH_STATUS = ["Not Registered", "Link Sent", "Registered", "Registration Failed"] as const;
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
  sidh_failure_reason: String, // why the portal refused — the queue is useless without the why
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
  // 2026-08-13 (Manish): "har row ke bagal mein source ka link" — sheet-imported batches carry
  // the tab they came from ("AVPL Batch_Master"); app-created ones leave it unset and the UI
  // says "Entered in ERP". Provenance is never guessed from the shape of the row.
  source: String,
  // 2026-08-12 (Manish): the batch is actually formed on the SIDH portal — "batch बन गया… अब मैं
  // उस location के TC ID और password से login करूँगा और student का enrollment उस batch में शुरू
  // कर दूँगा". Without the portal's own id there is no way to tie our row to theirs when an
  // attendance export or a discrepancy comes back.
  govt_batch_id: String,
  // "हम अपनी safety के लिए ये सारे records अपने पास capture करके drive वाले folder में डालते हैं" —
  // the evidence goes to the NSDC portal AND to a Drive folder kept in parallel.
  drive_folder_url: String,
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
  // 2026-08-13 (Karunn): per-student BIOMETRIC flag — "biometric done & present / not done &
  // present ho sakta hai; biometric done & NOT present nahi ho sakta" (Rule 51, enforced at
  // write). Day-level array, same shape as present_member_ids; always a subset of it.
  biometric_member_ids: { type: [Schema.Types.ObjectId], default: [] },
  // 2026-08-13 (Karunn): attendance is marked in ROUNDS — "din mein do baar, teen baar, jitni
  // baar bhi P-P-P, timestamp ke saath". Sessions are the append-only history of marking
  // rounds; the day-level arrays above are their running UNION, so every existing consumer
  // (counts, govt compare, gap queue) reads exactly what it always did. A day-level edit
  // (Rule 27 correction) REPLACES the day arrays and is recorded as a correction session.
  sessions: [{
    at: { type: Date, required: true },
    present_member_ids: { type: [Schema.Types.ObjectId], default: [] },
    biometric_member_ids: { type: [Schema.Types.ObjectId], default: [] },
    marked_by: oid("User"),
    correction: Boolean,
  }],
  // 2026-08-13 (Manish): the government portal only accepts student attendance for a day on
  // which the trainer's own (biometric) attendance exists — "trainer attendance banayega tabhi
  // batch shuru hogi". Mirrored here: a log with students present must assert the trainer was
  // in. Absent on legacy rows (pre-field) — validation applies at write time only.
  trainer_present: Boolean,
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
  // DEC-4 (Umesh, 2026-08-13): dropped-but-passed candidates do NOT count for invoicing.
  // `passed` stays the true pass count (Rule 42 readers unchanged); these two carry the split
  // so the invoice flow bills off billable_passed, never raw passed.
  dropped_passed: Number, billable_passed: Number,
  certification_status: { type: String, enum: PENDING_DONE, default: "Pending" },
  certification_date: Date, certificates_issued: Number, certificate_file: String,
  ready_for_invoice: { type: Boolean, default: false },
  marked_ready_by: oid("User"), marked_ready_at: Date,
  // Rule 52 (CEO 13/08): Closed = the MONEY story is over — invoice paid AND every due
  // (trainer, centre, vendor) settled. This flag is the human attestation of the latter.
  dues_settled: { type: Boolean, default: false },
  dues_note: String,
  dues_marked_by: oid("User"), dues_marked_at: Date,
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
  // 2026-08-14 (QA-042): row created by the certificate bulk upload on an already-Completed
  // batch, rather than by per-candidate marking. The freeze guard reads this to tell a
  // never-marked legacy batch from one that was genuinely marked — a snapshot count could
  // not, and a second tranche of certificates used to recompute protected figures.
  late_arrival: { type: Boolean, default: false },
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
// 2026-08-13: generalized beyond Location. A tab mapping (user-approved column→field mapping on
// a watched tab) can target Trainers and Candidates too; entity_type/entity say what the change
// is about, `location` stays for the original mapped sync and for scoping the inbox.
export const SHEET_CHANGE_ENTITY = ["Location", "Trainer", "Candidate"] as const;
const SheetChangeSchema = new Schema({
  sync_source: oid("SyncSource", true),
  location: oid("Location"),
  entity_type: { type: String, enum: SHEET_CHANGE_ENTITY, default: "Location" },
  entity: { type: Schema.Types.ObjectId, refPath: "entity_type" },
  tab: String, // which tab of the workbook produced this change (tab mappings only)
  field_name: { type: String, required: true },
  old_value: String, new_value: String,
  detected_at: { type: Date, required: true, default: () => new Date() },
  status: { type: String, enum: SHEET_CHANGE_STATUS, required: true, default: "Open" },
  impact_snapshot: Schema.Types.Mixed,
  action_taken: { type: String, enum: [...SHEET_CHANGE_ACTION, null], default: null },
  note: String,
  actor: oid("User"), actioned_at: Date,
}, { timestamps: true });

// ---------- TabMapping (2026-08-13) ----------
// User-approved column→field mapping for ONE tab of a watched workbook. This is what makes the
// system self-sufficient on a server with no operator: when a new tab appears, anyone with
// sheet.sources opens the wizard, validates the proposed mapping, and from then on the 5-minute
// watch ingests that tab — new rows are created outright (that IS what approving the mapping
// means), changed rows become SheetChange review items (a human said OK before anything is
// overwritten), unresolvable rows are named in last_report. Never guessed, never silent.
const TabMappingSchema = new Schema({
  sync_source: oid("SyncSource", true),
  tab: { type: String, required: true },
  entity_type: { type: String, enum: SHEET_CHANGE_ENTITY, required: true },
  // [{header: "Mobile Number", field: "phone"}] — headers not listed are ignored.
  columns: { type: [{ header: String, field: String, _id: false }], default: [] },
  // Fixed values applied to every row of this tab — e.g. {location: "<id>", program: "<id>"}
  // for a per-district candidate tab where centre/job role are facts about the tab, not columns.
  constants: { type: Schema.Types.Mixed, default: {} },
  key_field: { type: String, required: true }, // which mapped field identifies a row (phone, external_id…)
  active: { type: Boolean, default: true },
  approved_by: oid("User"), approved_at: Date,
  initial_imported: { type: Boolean, default: false },
  last_run_at: Date,
  last_report: { type: Schema.Types.Mixed, default: {} }, // {created, updated_review, unchanged, skipped: [reason…]}
}, { timestamps: true });
TabMappingSchema.index({ sync_source: 1, tab: 1 }, { unique: true });

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
// (Admin/Ops generate and share); feedback and attendance tokens are per batch-member
// (attendance added 2026-08-13: "bacche puchte hain sir mera kitna ho gaya attendance" —
// each student gets a link showing their own days/hours/eligibility, nobody else's).
// trainer_apply added 2026-08-14 (CEO: "Add Trainer ke fields as a form uske paas chala
// jaye, wo khud bhar de — Divya naam-email-phone dale, link WhatsApp/SMS chala jaye").
export const PUBLIC_TOKEN_PURPOSE = ["register", "feedback", "attendance", "trainer_apply"] as const;
const PublicTokenSchema = new Schema({
  token: { type: String, required: true, unique: true },
  purpose: { type: String, enum: PUBLIC_TOKEN_PURPOSE, required: true },
  location: oid("Location"),    // register: which location's pool the candidate lands in
  program: oid("Program"),      // register: optional preselected program
  batch_member: oid("BatchMember"), // feedback: who this link belongs to
  trainer: oid("Trainer"),      // trainer_apply: the pre-created profile this link completes
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
  // 2026-08-13 eval sweep: these two were in the PUT whitelist and in DEFAULT_VALUES but NOT in
  // this schema — strict mode silently dropped every write, so the Admin panel's knob never
  // actually persisted (the fallback default masked it).
  drive_root_url: { type: String, default: "https://drive.google.com/drive/folders/1NOfRCw9lIyRoJTEFAg4--HIJiTG-Of0G" },
  snapshot_retention_per_tab: { type: Number, default: 100 },
  // Scheme timing guidelines. 2026-08-13 (Manish, meeting): a session is EXACTLY 4 hours or
  // EXACTLY 8 hours inside the 9-to-6 day — "ya toh 4 ghante ka rakho ya 8 ghante ka… beech
  // ka tod-mod nahi" (supersedes the 2026-08-12 ≤4h ceiling; max_session_hours is no longer
  // consulted by slot validation and remains only for back-compat with stored Defaults docs).
  day_start_time: { type: String, default: "09:00" },
  day_end_time: { type: String, default: "18:00" },
  max_session_hours: { type: Number, default: 4 },
  max_batches_per_day: { type: Number, default: 2 },
  // 2026-08-13 (Manish): "60 plus hona mandatory hai" — minimum attendance, as a percent of
  // programme hours, to qualify for the assessment. Contract-tunable like the counters below.
  min_attendance_pct: { type: Number, default: 50 },
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
export const TrainerDocument = models.TrainerDocument || model("TrainerDocument", TrainerDocumentSchema);
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
export const TabMapping = models.TabMapping || model("TabMapping", TabMappingSchema);
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
