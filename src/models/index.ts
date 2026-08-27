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
// 2026-08-14 (CEO recorded review [06:38]): "fresh lead, then shortlisted, … document
// completed, … sent to NSDC, NSDC approved, TOT done, and then … Certified is a better word."
// The STORED names are the CEO's vocabulary — renamed outright during the post-wipe empty-DB
// window, so there is no label layer left to drift from the data (the QA-045 bug class).
// Docs collection happens while Shortlisted; "Documents Completed" is entered through the
// Rule T2 all-documents gate. Legacy sheet values are still accepted as import aliases.
export const TRAINER_PIPELINE = [
  "Fresh Lead",
  "Shortlisted",
  "Documents Completed",
  "Sent to NSDC",
  "NSDC Approved",
  "NSDC Rejected",
  "TOT Payment Done",
  "TOT Scheduled",
  "TOT In Progress",
  "Certified",
  "Dropped",
] as const;

// The documents Manish listed by name, plus the two experience certificates that are mandatory
// for TVP eligibility on some job roles.
// -129 (QA-268, Divya 18/08: "instead of CIPSA certificate, we should mention CITS certificate").
// CIPSA is not a credential; the trainer certification is CITS — Craft Instructor Training Scheme —
// and the live row labelled "CIPSA Certificate" holds a file named CITS Certificate.pdf, which is
// the product being corrected by the person using it. Renamed at the source rather than papered
// over with a label map: this value is STORED, so a display layer would leave the wrong string in
// the database and in every export. scripts/migrate-cits-doctype.mjs moves the two collections that
// hold it — and the second one matters more than it looks: a Program whose mandatory_trainer_docs
// still says "CIPSA Certificate" would demand a document type the UI can no longer offer, and Rule
// T2 would refuse Documents Completed for that programme's trainers forever.
export const TRAINER_DOC_TYPE = [
  "Aadhaar", "PAN", "Photo", "CV", "Educational Qualification",
  "CITS Certificate", "Industry Experience", "Teaching Experience", "Other",
] as const;

// The government schemes actually running, from the client's RPL workbook (2026-08-12).
// Priority is the CEO's: "पहले हमें ABPL, HSL दूसरे priority पे है, तीसरे पे ये है".
export const SCHEME = ["RPL-AVPL", "RPL-HSL", "PMKVY-BECIL", "DDU-GKY2.0", "DDUGKY 2.0 SPH"] as const;
// CEO named four: "एक तो बैच वाइज पैसे देते हैं, एक किसी को मंथली देते हैं… एक तो हो गया
// फिक्स, और एक होता है इंसेंटिव बेस्ड ऑन देयर परफॉरमेंस". Only two were selectable (2026-08-12).
export const COMPENSATION_TYPE = ["Batch-wise", "Monthly", "Fixed", "Incentive-based"] as const;
export const TRAINER_REQUEST_STATUS = ["Open", "In Progress", "Fulfilled", "Cancelled"] as const;
// "Failed" (CEO 14/08 [28:28]: "they completed the training and they failed … the second
// stage is fail"): finished the batch but did not pass — not Completed (which would inflate
// outcome reporting) and not Dropped (they never left). Renamed from "Not Certified" during
// the empty-DB window.
export const LIFECYCLE_STATUS = ["Unassigned", "Assigned", "Enrolled", "Dropped", "Completed", "Failed"] as const;
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
  default_batch_size: { type: Number, required: true, default: 45 }, // -117 (M4-09, Manish): 45, not 30 — per PROGRAMME, so existing ones keep their own figure until edited
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
  // R-H (CEO 14/08 [03:14]): "we can also capture, which should be visible only to our
  // admin, the amount that we are getting" — per centre-scheme-role money; masked for every
  // non-Admin reader at the API.
  contract_amount: Number,
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
  // QA-117 (CEO, first three minutes): every institution gets ONE unique id of its own.
  // Sparse: legacy rows without one stay valid; the value's naming scheme (TC-id-derived
  // or its own series) is Karunn's pending call — the FIELD does not wait for it.
  institution_id: { type: String, unique: true, sparse: true, trim: true },
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
  // -129 (QA-271, Divya 18/08): the centre picker carries a selectable placeholder, "yet to be
  // identify". Location was the ONE master with no way to retire a row — Program, Room, Trainer,
  // Scheme and JobRole all carry this flag and every one of their pickers honours it, but the
  // `offerable()` helper (copied into three pages) had only ever been handed `programs`. Same
  // meaning here as there, in the words the Admin screen already uses: Active is offered when
  // something new is created; Retired is hidden from those pickers while every batch, candidate,
  // trainer and target already pointing at it keeps working. Retiring is a decision about what may
  // be STARTED, not about history — which is exactly why a junk row gets retired and not deleted.
  active: { type: Boolean, default: true },
  status_reason: String,
  status_changed_on: Date,
  spoc_name: String, spoc_phone: String, spoc_user: oid("User"),
  principal_name: String, principal_phone: String, principal_user: oid("User"),
  // QA-621 cycle 4: a SLOT (spoc / principal / cluster_head, the field above and
  // `cluster_head_name` further up) is a role label, not a person - its OCCUPANT can change by a
  // plain edit to the *_name field, and a plan link's identity (recipientKey() in lib/rules.ts)
  // has to tell "same occupant re-sent" apart from "a different person now holds this slot".
  // QA-1502 (cycle 2): these three counters are bumped STRUCTURALLY, by the middleware below this
  // schema, and only when the matching *_name field is actually set to a different value - never
  // client-writable directly (not in any itemRoutes `fields` allowlist). The bump used to be a
  // call each write path had to remember to make; two shipped routes did not, and that is exactly
  // how the previous five fixes died.
  spoc_gen: { type: Number, default: 0 },
  principal_gen: { type: Number, default: 0 },
  cluster_head_gen: { type: Number, default: 0 },
  // 2026-08-11 meeting: "एक SPOC, दो SPOC… कोई और contact person है तो वो सब ऐड कर पाऊं" —
  // any number of named contacts beyond the two legacy slots above (which stay untouched).
  contacts: [{
    name: { type: String, required: true },
    phone: String,
    role_label: { type: String, default: "Contact" }, // SPOC / Principal / Cluster Head / Contact…
    user: oid("User"),
  }],
}, { timestamps: true });

// ══ QA-1502 (QA-558/QA-621 cycle 6) — THE SLOT GENERATION IS MAINTAINED BY THE SCHEMA ═══════════
//
// A plan link's identity (recipientKey() in lib/rules.ts) folds in the GENERATION of the slot it
// was minted for, so that when a centre hands its SPOC chair to a different human the new
// occupant's mint lands on a different key and cannot revoke the old occupant's live link.
//
// That only works while the counter actually moves. Cycle 1 moved it by having every write path
// CALL a helper, and a checker then found two shipped, Admin-clickable routes that never did:
// `applySheetChange` case "Apply value" and `POST /api/sheet-changes/[id]/revert`, both of which do
// a plain `doc.set(field, value); doc.save()` on a Location. Two presses of the ★-recommended
// button in the Sync Inbox renamed a SPOC and back, the generation stayed at 0, and the first
// person's link died — the same {404, 200} this S1 has produced for five releases.
//
// The lesson of six root causes on one bug is that "every write path remembers" is not a mechanism,
// it is a hope. So the bump lives HERE, on the model, in one place, and fires for every Mongoose
// write that reaches a Location — a route written next year, a migration, a seed script, an
// importer. The only writes it cannot see are ones that bypass Mongoose entirely and speak to the
// driver's raw collection (`admin/avpl-rebase`, which reads-then-upserts through
// `Location.collection`); that route calls slotGenerationBumps() itself and says why.
//
// SLOT_OCCUPANT_FIELDS lives with the schema rather than in lib/rules.ts because the middleware
// below needs it and rules.ts already imports this module (a definition here, imported there, is
// the only direction that has no cycle). rules.ts RE-EXPORTS both names, so every existing
// importer is unchanged and there is still exactly one definition (ARCHITECTURE §3).
export const SLOT_OCCUPANT_FIELDS: Record<string, { nameField: string; genField: string }> = {
  spoc: { nameField: "spoc_name", genField: "spoc_gen" },
  principal: { nameField: "principal_name", genField: "principal_gen" },
  cluster_head: { nameField: "cluster_head_name", genField: "cluster_head_gen" },
};

// Given a Location's CURRENTLY STORED fields and a patch about to be written to it, return the
// generation bumps that write must fold into the SAME write. The one place this comparison is made.
// The middleware below is its only caller inside `src/`; `admin/avpl-rebase/route.ts` calls it
// directly because its write never reaches Mongoose.
export function slotGenerationBumps(
  existing: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, number> {
  const bumps: Record<string, number> = {};
  for (const { nameField, genField } of Object.values(SLOT_OCCUPANT_FIELDS)) {
    if (!(nameField in patch)) continue; // this write does not touch this field at all
    const before = String((existing as any)?.[nameField] ?? "").trim();
    const after = String(patch[nameField] ?? "").trim();
    if (before !== after) bumps[genField] = Number((existing as any)?.[genField] ?? 0) + 1;
  }
  return bumps;
}

// QA-1505 (cycle 2): two contact subdocuments sharing one `_id` on the same centre. A checker got
// two of them stored through `PATCH /api/locations/[id]` (200), and then the plan screen offered
// two DIFFERENT people under ONE ref while the mint - which resolves `contact:<id>` by taking the
// FIRST row with that id - collapsed them to one, and revoked the wrong person's link. The ref is
// the durable half of the two-signal identity, so a duplicated ref is not a cosmetic data problem;
// it is the identity itself becoming ambiguous. It is refused at the door instead, for every
// Mongoose write, because "which door accepts contacts" is a question with more than one answer.
function assertContactIdsUnique(contacts: unknown) {
  if (!Array.isArray(contacts)) return;
  const seen = new Set<string>();
  for (const c of contacts) {
    const id = String((c as any)?._id ?? "").trim();
    if (!id) continue; // a new row without an id: Mongoose mints a fresh unique one
    if (seen.has(id)) {
      // Shaped exactly like a Mongoose custom-validator failure so apiHandler answers 400 with THIS
      // sentence (the `properties.message` branch in lib/authz.ts) rather than a generic refusal.
      const msg = "Two of this centre's contacts carry the same id, so a plan link sent to one of them could not say which of the two people it belongs to. Remove the duplicate row and save again.";
      const e: any = new Error(msg);
      e.name = "ValidationError";
      e.errors = { contacts: { kind: "duplicate-contact-id", properties: { message: msg } } };
      throw e;
    }
    seen.add(id);
  }
}

// The document path: `new Location(...)`, `doc.set(...) + doc.save()` (the Sync Inbox's "Apply
// value" and the revert route), and crud.ts's `existing.save()` behind PATCH /api/locations/[id].
// `isModified` IS the comparison here - Mongoose marks a primitive path modified only when it is
// set to a value that differs from the one loaded from the database, which is precisely the
// question slotGenerationBumps() asks of a patch.
// (`as any` on the two registrations below only because `new Schema({...})` here is untyped, so
// Mongoose's overloads cannot narrow the hook name — nothing about the hooks themselves.)
// (Promise-style rather than the `next` callback: `save` is also registered for the document form
// of `updateOne`, and the two are invoked with different arguments — an `async` hook is the one
// shape Mongoose calls the same way for all of them.)
(LocationSchema as any).pre("save", async function (this: any) {
  if (this.isModified("contacts")) assertContactIdsUnique(this.get("contacts"));
  if (this.isNew) return;
  for (const { nameField, genField } of Object.values(SLOT_OCCUPANT_FIELDS)) {
    // A caller that set the counter itself in the same save wins - nothing in `src/` does, but
    // a bump applied twice would be silently wrong in the rotation direction rather than loudly.
    if (this.isModified(nameField) && !this.isModified(genField)) {
      this.set(genField, Number(this.get(genField) ?? 0) + 1);
    }
  }
});

// The query path: `findByIdAndUpdate` / `findOneAndUpdate` / `updateOne` / `updateMany` /
// `replaceOne`. There is no document in hand, so the before-values are read here and the counters
// are advanced with their own `$inc` per affected document - `$set`-ing a computed number would be
// wrong the moment a query matches more than one centre, and `$inc` in the caller's own update
// would collide with an explicit `$set` of the same path ("Updating the path ... would create a
// conflict"). Written through `collection` so this middleware does not re-enter itself.
(LocationSchema as any).pre(["findOneAndUpdate", "updateOne", "updateMany", "replaceOne"], async function (this: any) {
  const raw = this.getUpdate() ?? {};
  if (Array.isArray(raw)) return; // an aggregation-pipeline update; nothing in `src/` writes one
  const flat: Record<string, unknown> = { ...(raw.$set ?? {}), ...(raw.$setOnInsert ?? {}) };
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith("$")) flat[k] = v;

  if ("contacts" in flat) assertContactIdsUnique(flat.contacts);

  const touched = Object.values(SLOT_OCCUPANT_FIELDS).filter(({ nameField, genField }) =>
    nameField in flat
    && !(genField in flat)                                   // an explicit counter write wins
    && !(genField in (raw.$inc ?? {})));
  if (!touched.length) return;

  const docs = await this.model.find(this.getQuery())
    .select("spoc_name principal_name cluster_head_name").lean();
  for (const doc of docs) {
    const inc: Record<string, number> = {};
    for (const { nameField, genField } of touched) {
      if (String((doc as any)[nameField] ?? "").trim() !== String(flat[nameField] ?? "").trim()) inc[genField] = 1;
    }
    if (Object.keys(inc).length) await this.model.collection.updateOne({ _id: (doc as any)._id }, { $inc: inc });
  }
});

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
  // Hiring pipeline (2026-08-11; renamed to the CEO's vocabulary 2026-08-14).
  // Default is the START of the journey — a new trainer is a fresh lead.
  pipeline_status: { type: String, enum: TRAINER_PIPELINE, default: "Fresh Lead" },
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
  // -169 (QA-399), Karunn sir's Back-dated Planning columns 5, 6 and 13. They sit HERE, inside the
  // NSDC block, because they are part of the same round-trip and splitting them would be the first
  // step toward a second place where a trainer's preparation is recorded.
  sidh_profile_verified_on: Date,   // col 5  - TR ID + experience letters generated on SIDH
  eligibility_checked_on: Date,     // col 6  - pipeline "Documents Completed" is a DIFFERENT question
  // col 13. EXPECTED, deliberately distinct from tot_certificate_no which is the OUTCOME: he tracks
  // the date he is waiting on, and a field that only exists once the wait is over cannot be tracked.
  tot_result_expected_on: Date,
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
  dropped_from_stage: String,           // CEO: which stage the journey ended at ("Dropped at Shortlisted")
  // QA-130 rider (15/08, Umesh: "kisne banaya, user-wise, backtracking ke liye"): crud.ts has
  // always SET created_by on create — this schema just never declared it, so mongoose dropped
  // it silently and only the audit row kept the answer. Declared, it shows on the row itself.
  created_by: oid("User"),
  // 15/08 (Umesh): columns the bulk upload didn't recognise, kept when the operator accepts
  // them ("restrict mat karo — data mil jaye"). {columnName: stringValue}, read-only facts.
  custom_fields: { type: Schema.Types.Mixed, default: undefined },
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

// ---------- CandidateDocument (QA-105, 15/08) ----------
// Candidates had no document store at all — no model, no route, no screen — while the
// SIDH walk needs Aadhaar/photo/education proofs on file. Full mirror of the trainer
// pattern, delete included from day one (QA-112's lesson: a wrong file must be removable).
export const CANDIDATE_DOC_TYPE = [
  "Aadhaar", "PAN", "Photo", "Educational Qualification", "Bank Passbook", "Other",
] as const;
const CandidateDocumentSchema = new Schema({
  candidate: oid("Candidate", true),
  doc_type: { type: String, enum: CANDIDATE_DOC_TYPE, required: true },
  file_url: { type: String, required: true },
  original_name: String,
  uploaded_by: oid("User"),
  note: String,
}, { timestamps: true });
CandidateDocumentSchema.index({ candidate: 1, doc_type: 1 });

// ---------- BatchDocument (2026-08-26) ----------
// The RPL compliance paperwork a batch must have on file — candidate registration forms,
// assessment-day photos, the signed final attendance sheet, post-certification photos. Daily
// training photos/attendance and trainer credentials are DELIBERATELY not here: the first is
// DailyLog (already a per-day record with photos/videos/attendance_sheet below), the second is
// TrainerDocument (already exists, read-only pull-through — see trainerDocSummary). This is a
// different concept: batch-level evidence with no natural per-day home.
// Unlike TrainerDocument/CandidateDocument (one row per doc_type, re-upload REPLACES), this is
// one row per FILE — a doc_type here routinely needs many files (several registration forms,
// several angle photos of one assessment day), so uploads APPEND.
export const BATCH_DOC_TYPE = [
  "Candidate Registration Forms",
  "Assessment Day Photos (Individual)",
  "Assessment Day Photos (Group)",
  "Final Assessment Attendance Sheet",
  "Post-Certification Photos (Individual)",
  "Post-Certification Photos (Group)",
] as const;
const BatchDocumentSchema = new Schema({
  batch: oid("Batch", true),
  doc_type: { type: String, enum: BATCH_DOC_TYPE, required: true },
  file_url: { type: String, required: true },
  original_name: String,
  uploaded_by: oid("User"),
  note: String,
}, { timestamps: true });
BatchDocumentSchema.index({ batch: 1, doc_type: 1 });

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
// 2026-08-24 (Umesh): "interested in current upcoming batch" vs "interested in future batches".
// Two values on purpose - a third ("Not interested") would duplicate the Dropped lifecycle state,
// which already carries a reason and a stage.
// 2026-08-25 (client call): on screen these two are "The current batch" and "Upcoming batch". The
// STORED values below are deliberately untouched - see FUTURE_INTEREST_TAG in lib/candidate-journey.ts
// for why a rename of the words is not a rename of the data.
export const BATCH_INTEREST = ["Current", "Future"] as const;
export const SIDH_STATUS = ["Not Registered", "Link Sent", "Registered", "Registration Failed"] as const;
const CandidateSchema = new Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  alt_phone: String, gender: String,
  dob: Date,            // RPL M8: name+DOB is the second duplicate-match key
  // -116 (SS-01, Shivshakti 17/08 13:00, filling our form beside the government's): every field the
  // Skill India "Skilling Program Application" asks for that we did not hold. Optional by design.
  salutation: String,                 // seen on the portal, never spoken — its validation error names nothing
  father_name: String,
  mother_name: String,
  marital_status: String,             // Single / Married / Other — free text until Manish fixes the list
  religion: String,
  social_category: String,            // General / OBC / SC / ST — "category" on the portal
  state: String,
  district: String,
  sub_district: String,
  // -126 (S18-03): these two left the FORM and both route whitelists — Shivshakti asked for them out,
  // and they were never in his spoken list of eight (I inferred them from the portal screenshot). The
  // COLUMNS stay: measured on live before removing, 0 of 206 candidates carry any portal field, so
  // nothing is lost by keeping them — and dropping a column is the one change that cannot be undone.
  address_type: String,               // no longer written by any route
  differently_abled: String,          // no longer written by any route
  // 2026-08-24 (Umesh): "candidate form mai aadhaar number nhi aa rha hai, aadhaar number k liye
  // form mai daal". This REVERSES a standing decision — the line below said "NOT the Aadhaar number
  // itself" and `export-sidh` shipped its aadhaar column blank on purpose. His call, taken with the
  // PII consequences named: `scripts/mirror-prod.mjs` redacts it so no local mirror carries live
  // Aadhaar numbers, the audit log stores only the last four, and it is deliberately NOT in the
  // list search or any table column — the form and the SIDH export are the only places it appears.
  // Validated by `aadhaarError` in lib/validate.ts (12 digits + Verhoeff), never stored unvalidated.
  aadhaar_no: String,
  // Still a DIFFERENT field, and the distinction is now load-bearing rather than academic: QA-414
  // measured 55 live candidates whose PORTAL id landed in this box because it was the closest-looking
  // option on screen. Two government-ID fields side by side is a fresh chance to repeat that.
  id_reference: String, // some other government ID reference — NOT Aadhaar (that is aadhaar_no) and NOT the portal CAN id (that is sidh_candidate_id)
  // -124 (M4-04): OPTIONAL. A walk-in belongs to no centre until somebody enrols them, and forcing a
  // centre at entry either invents a fact or turns the person away. The centre is set by the first
  // real event instead — see members/route.ts, where a location-less candidate adopts the batch's
  // centre exactly as a programme-less one already adopts its programme.
  location: oid("Location"),
  program: oid("Program", true),
  source: String,
  education: { type: String, enum: [...EDUCATION_LEVEL, null], default: null },
  last_training_date: Date, // "last training कब हुई वो date ले लो" — eligibility flips when the cooldown lapses
  interested_programs: [{ type: Schema.Types.ObjectId, ref: "Program" }],
  interested_locations: [{ type: Schema.Types.ObjectId, ref: "Location" }],
  // 2026-08-24 (Umesh): "candidate form mai candidate k paas hoga option interested in current
  // upcoming batch ya firr hoga interested in future batches … isse ye hoga ki jo candidates jo abhi
  // avilable nhi hai but future mai interested hogne, hmare paas unka status hoga."
  //
  // A SEPARATE axis from lifecycle_status and from sidh_status, deliberately. Those say how far a
  // person has come; this says whether they want THIS intake. They are independent: a
  // future-interested candidate can already be registered on the government portal, and that
  // combination is exactly the "quality lead" Umesh described - the one worth calling back. Folding
  // this into the lifecycle enum would have forced a choice between showing their stage and showing
  // their availability, and would have needed the add->migrate->remove dance LANDMINE 1 describes.
  //
  // Default "Current", so every record written before this field existed reads as available - which
  // they are, and which keeps every existing candidate enrollable exactly as they were. Absent is
  // never treated as Future anywhere: `addMemberChecked` refuses only on the explicit value.
  batch_interest: { type: String, enum: BATCH_INTEREST, default: "Current" },
  sidh_status: { type: String, enum: SIDH_STATUS, default: "Not Registered" },
  // -134 (QA-283, Umesh 19/08): "ab document dobara mark nahi kar payenge, SIDH portal pe sab kar
  // liya." For cohorts that ran before this ERP existed, the documents were completed on the
  // government portal and CANNOT be re-marked here — so an "Unverified" chip on them is not merely
  // irrelevant, it is unfixable by design. This is the mark that clears them, and it is set by a
  // PERSON. Nothing derives it: "the batch is running, so the documents must exist" is an inference,
  // and QA-085 is the rule that says a thing we do not know must stay unknown rather than become a
  // confident yes. Who and when are recorded because that is what makes it evidence rather than a flag.
  sidh_docs_verified: { type: Boolean, default: false },
  sidh_docs_verified_by: oid("User"),
  sidh_docs_verified_on: Date,
  sidh_link_sent_at: Date,
  sidh_registered_on: Date,
  sidh_failure_reason: String, // why the portal refused — the queue is useless without the why
  // 15/08 (Umesh): email mandatory on SELF-registration (the email pipeline is coming) —
  // optional everywhere else (drawer, imports), so old data never blocks.
  email: String,
  // Portal "Candidate ID" (CAN_40918461). The government attendance export keys on this, so it
  // is the only reliable join — names repeat within a centre.
  sidh_candidate_id: { type: String, default: null },
  // 2026-08-24 (Umesh): the government APAAR ID - "jaise abhi candidate id aati hai vaise hi govt
  // APAAR ID hota hai". Automated Permanent Academic Account Registry, 12 digits, read off the
  // government portal exactly as the CAN id above is, which is why it sits here and not beside
  // aadhaar_no.
  //
  // THIS IS THE THIRD GOVERNMENT-ID FIELD ON THIS SCHEMA, and the note 30 lines up is about exactly
  // that hazard: QA-414 measured 55 live candidates whose PORTAL id landed in id_reference because
  // it was the closest-looking box on screen. apaar_id and aadhaar_no are BOTH 12 digits, so this
  // pair is more confusable than that one was. Two things exist because of it: every door refuses an
  // APAAR that equals that same candidate's aadhaar_no (by name, so the operator knows which box
  // they are in), and the import catalog lists this ABOVE id_reference so a sheet's APAAR column has
  // a correct destination rather than a nearest-looking one.
  //
  // Validated by `apaarError` in lib/validate.ts - 12 digits, NOT the Aadhaar rules (see the comment
  // there: a real APAAR begins with 1, which aadhaarError refuses outright).
  apaar_id: { type: String, default: null },
  lifecycle_status: { type: String, enum: LIFECYCLE_STATUS, required: true, default: "Unassigned" },
  // CEO 14/08 [15:21]: "I hope we are also capturing when a candidate is enrolled" — stamped
  // once, the first time enrollment completes (Rule 21); never cleared on a later drop, so a
  // training dropout stays distinguishable from an inquiry that never enrolled.
  enrolled_at: { type: Date, default: null },
  // R-J (QA-049, Umesh 14/08): the CEO's "enrolled = fees paid" needs the fee ON the
  // candidate. Whether an unpaid fee BLOCKS enrollment is a Defaults toggle
  // (fee_required_for_enrollment) — some schemes are government-funded and charge nothing.
  fee_amount: Number,
  fee_paid_on: Date,
  fee_reference: String,
  // QA-021 (-68, the CEO's loudest repeated ask): a dropout is a recorded FACT, not just an
  // enum value only a roster removal could reach. Mirrors the trainer's pair (dropped_reason /
  // dropped_from_stage) so both funnels speak "Dropped (at <stage>)".
  dropped_reason: String,
  dropped_at: Date,
  dropped_from_stage: String,
  created_by: oid("User"),
  // 15/08 (Umesh): accepted unknown columns from bulk upload — see TrainerSchema note.
  custom_fields: { type: Schema.Types.Mixed, default: undefined },
}, { timestamps: true });

// -154 (QA-417): one portal ID belongs to at most one candidate, enforced by the DATABASE and not
// by whoever writes next. sidh_candidate_id is the join key for BOTH the government attendance
// export and the certificate matcher, so a duplicate silently sends one student's hours - and
// later their certificate - to another person.
//
// partialFilterExpression on $type, NOT sparse: true. That is the shape this codebase already
// trusts for exactly this problem (TrainerSchema tr_id, CandidateResultSchema certificate_no) -
// a sparse unique index still collides on the SECOND null in some server versions, while a
// partial filter simply does not index a document that has no string there.
//
// EMPTY STRING IS THE HOLE THIS LEAVES: "" is a string, so two candidates holding "" would
// collide and the second write would be refused. Every writer must store undefined/null, never
// "" - which is why the import writer trims and drops empties rather than writing a blank.
CandidateSchema.index({ sidh_candidate_id: 1 }, { unique: true, partialFilterExpression: { sidh_candidate_id: { $type: "string" } } });

// QA-902 (2026-08-24): the same guarantee for the APAAR ID, for the same reason and with the same
// shape. An APAAR number identifies ONE student to the government; two candidate rows holding it
// means one of them is wrong, and the cheapest moment to learn that is the moment somebody types
// the second one - not months later when the portal rejects a student. The EMPTY-STRING hole
// applies here too and is the reason every writer of this field stores undefined/null and never "".
CandidateSchema.index({ apaar_id: 1 }, { unique: true, partialFilterExpression: { apaar_id: { $type: "string" } } });

// ---------- Batch ----------
const BatchSchema = new Schema({
  code: { type: String, required: true, unique: true },
  location: oid("Location", true),
  program: oid("Program", true),
  trainer: oid("Trainer"),
  room: oid("Room"),
  session: { type: String, enum: BATCH_SESSION, default: "Full Day" },
  // QA-133 (Umesh, 15/08): which skills matter for THIS batch is the operator's recorded
  // choice at batch time — it never filters the trainer dropdown. Replaces the unrequested
  // trainer-skill string match that hid a certified trainer over a two-word difference.
  relevant_skills: [String],
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
  // QA-152 (Umesh, 15/08): "planning is a deliberate act, not a side-effect of saving a
  // batch" — the plan exists only when someone asks for it (plan_enabled). Batches created
  // before -81 keep their auto-generated milestones in the DB but they stay hidden (and raise
  // no overdue alerts, no lead-time verdicts) until "Create backward plan" is pressed.
  plan_enabled: { type: Boolean, default: false },
  milestones: [{
    key: String, label: String,
    due_date: Date,
    done_on: Date, done_by: oid("User"),
    // QA-152 part 2 (-82): the plan is an editable artifact — notes and an owner per row,
    // rows the planner adds by hand (custom), and how a tick arrived (user | link).
    notes: String, owner_label: String,
    custom: { type: Boolean, default: false },
    done_via: String,
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
  // 15/08 (Umesh): accepted unknown columns from bulk upload — see TrainerSchema note.
  custom_fields: { type: Schema.Types.Mixed, default: undefined },
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
  // REQ-202 (Rule 28, amended 2026-08-27): frozen at save, may never DECREASE, and may increase
  // for exactly one reason — a member whose `joined_on` is on or before this log's date, and who
  // was therefore genuinely on that day's Rule 26 roster (REQ-119), was not yet counted in it.
  roster_count: { type: Number, required: true },
  govt_present: { type: Number, default: null },
  govt_source: { type: String, enum: GOVT_SOURCE, default: "Manual" },
  govt_screenshot: String,
  // REQ-421 (QA-1055, 2026-08-27 — Umesh's own answer: "Flag the day for review when this
  // happens"): raising `roster_count` on a day that ALREADY carries a government figure silently
  // rewrites the denominator of a number that has been reported — 33/33 becomes 33/37 without
  // anyone touching the portal. The contract forbids resubmitting or restating it automatically,
  // so the day is MARKED instead and a person decides. Written only by the two daily-log edit
  // doors; cleared by nothing in code — a person clears it once they have dealt with the portal.
  govt_review: {
    needed: { type: Boolean, default: false },
    reason: String,
    roster_count_before: Number,
    roster_count_after: Number,
    govt_present_at_flag: Number,
    flagged_at: Date,
  },
  photos: { type: [String], default: [] },
  videos: { type: [String], default: [] },
  // 2026-08-26 (RPL compliance): the client requires the signed manual attendance register
  // photographed daily, alongside training photos — same evidence class as `photos`, kept as its
  // own field rather than folded into `photos` because a batch-document checklist (BatchDocument
  // above) needs to ask "does this day have its attendance sheet" separately from "does it have
  // training photos", and a single mixed array cannot answer that.
  attendance_sheet: { type: [String], default: [] },
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
  // -112 (QA-219): "Completed" can now be DERIVED from the per-candidate rows. A derived sign-off
  // is a restatement of the rows, not a human attesting reported figures — so it must be
  // reversible, and it must not slam the doors a human sign-off rightly slams. These say which.
  assessment_derived: { type: Boolean, default: false },
  assessment_date: Date, appeared: Number, passed: Number, result_file: String,
  // -120 (M4-14, Manish 17/08 [09:17], typed on screen): the dates his chain asks for and the ERP
  // never held. Each is optional and independent — recording a mock-test date must never become a new
  // gate on a batch that never ran one. His mock-test STATUS wording is still owed, so no enum here.
  mock_test_date: Date,               // "Mock Test/Formulation Test Date"
  result_expected_date: Date,         // "assessment hone ke baad, result tentative date"
  certificate_distribution_date: Date, // "certificate distribution date"
  sidh_uploaded_on: Date,             // "certificate upload on SIDH portal" — when it went up
  // DEC-4 (Umesh, 2026-08-13): dropped-but-passed candidates do NOT count for invoicing.
  // `passed` stays the true pass count (Rule 42 readers unchanged); these two carry the split
  // so the invoice flow bills off billable_passed, never raw passed.
  dropped_passed: Number, billable_passed: Number,
  certification_status: { type: String, enum: PENDING_DONE, default: "Pending" },
  certification_derived: { type: Boolean, default: false },
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

  // -120 (M4-14): the mock test, per candidate. "Who all are APPEARING for the mock test" and "who
  // all are QUALIFYING — yeh data aayega" are two different lists in his words, so they are two
  // fields, not one flag: a candidate can appear and not qualify, and that gap is the thing the
  // centre acts on before the real assessment. Both optional; a batch that never ran a mock test
  // simply leaves them unset. `mock_note` carries WHY someone did not qualify — the same discipline
  // Rule 44 already enforces for a Fail, which is M4-17's ask applied to the mock test.
  mock_appeared: { type: Boolean, default: undefined },
  mock_qualified: { type: Boolean, default: undefined },
  mock_score: Number,
  mock_note: String,
  // "roll number upar dikhna chahiye" — the number the assessment body issues per candidate, which
  // the centre quotes on every call about a result. Distinct from certificate_no (Rule 46) and from
  // sidh_candidate_id (the portal identity).
  roll_no: String,

  // M17 — assessment
  result: { type: String, enum: ASSESSMENT_RESULT, default: "Pending" },
  score: Number,
  max_score: { type: Number, default: 100 },
  assessed_on: Date,
  assessor: String,
  failure_reason: String,
  failure_note: String,
  // A-09 (24-Aug issues sheet, screen-read - nobody raised it aloud). A card carrying the red
  // "Not eligible" pill kept a fully live Pass button: no confirmation, no guard, and nothing
  // recorded that an override had happened. A Pass is what unlocks a certificate, so that was the
  // route by which somebody who did not do the 60 hours ends up certified with no trace of a
  // decision. Umesh, asked directly on 2026-08-25 who may do it: "anyone who can mark" - so this is
  // NOT gated on role, and the whole weight falls on the record instead.
  eligibility_override_reason: String,
  eligibility_override_by: oid("User"),
  eligibility_override_at: Date,
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
  // QA-1263 (2026-08-25): what the last run's books said - the sheet's own target total, what
  // landed, what each skip reason carried away, and the unexplained remainder. Mixed rather than a
  // sub-schema because the SHAPE is owned by sync.ts (`TargetRecon`) and a second declaration here
  // is the ARCHITECTURE section 3 disease; the reader that matters (reportSyncGap) imports that type.
  last_target_recon: { type: Schema.Types.Mixed, default: null },
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
  // QA-805 (-219, checker on qa-218): "was this applied change REVERTED?" as a fact, not as prose.
  // -218's re-open confirmation decided which warning to show by running /Revert/i over `note` - and
  // `note` carries free text a person typed. A row noted "do NOT revert this" was therefore told it
  // had been reverted, which DELETED the true warning ("this is already applied; re-opening puts it
  // in line to be written a second time"). A safety sentence chosen by grepping someone's sentence
  // is not a safety sentence.
  reverted_at: Date,
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
  // R-E (CEO 14/08 [25:20]): Operations posts an expense/revenue entry; it lands with the
  // Admin, and only an approval writes the ledger row.
  "cost.post",
  // R-F (CEO 14/08 [37:23]): a SPOC's centre-detail change is "sent for the approval to
  // the admin before we kind of change it".
  "location.edit",
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

// ---------- MailLog (QA-115, 2026-08-15) ----------
// One row per outbound-email ATTEMPT — sent, failed, or skipped (mail off / no creds).
// This is the answer to "mail gaya ki nahi?": the CEO's [19:48] complaint was exactly a
// send nobody could prove either way. Bodies are not stored (PII bloat); subject + to +
// outcome are the record.
// QA-132 (-72): "sent" was only ever SES ACCEPTANCE. Bounce/complaint notifications (SNS →
// /api/public/ses-notifications) now revise the row — the one MailLog mutation in the system.
export const MAIL_STATUS = ["sent", "failed", "skipped", "bounced", "complained"] as const;
// -110 (Umesh 17/08, checker QA-187..190): SMS lands in the SAME log. "Is bachche ko kuch gaya ki
// nahi" stays one query and one Admin screen — a second log would split that answer in two. So
// `channel` says which door it went through, `subject` becomes optional (an SMS has none; the
// template id and the first words of the body stand in), and `template_id` carries the DLT
// template an SMS was rendered from. Every existing row is email, so nothing migrates.
export const MESSAGE_CHANNEL = ["email", "sms"] as const;
const MailLogSchema = new Schema({
  channel: { type: String, enum: MESSAGE_CHANNEL, default: "email" },
  to: { type: String, required: true },
  subject: String,                             // -110: optional — SMS carries template_id + a body preview instead
  template_id: String,                         // -110: DLT template the SMS body was rendered from
  status: { type: String, enum: MAIL_STATUS, required: true },
  reason: String,                              // skip reason or failure message
  message_id: String,                          // SES message id / EnableX message id on success
  entity: String, entity_id: Schema.Types.ObjectId, // what this mail was about
}, { timestamps: true });
MailLogSchema.index({ createdAt: -1 });
MailLogSchema.index({ channel: 1, createdAt: -1 });

// ---------- Stored files (QA-145, 2026-08-15) ----------
// Every upload gets a row — "koi bhi data miss na ho" (Umesh). The checker proved that
// uploads written to the ECS task's own disk vanish on every deploy while their URLs stay
// in Mongo pointing at nothing. This row is the durable record: WHERE the bytes live
// (drive / local), the Drive file id + folder path when it is Drive, and what entity it
// belongs to. The user never sees Drive — the app proxies every read through /api/files.
export const FILE_BACKEND = ["local", "drive", "gcs"] as const;
const StoredFileSchema = new Schema({
  name: { type: String, required: true, unique: true }, // the 32-hex capability name (+ext)
  original_name: String,
  mime: String,
  size: Number,
  backend: { type: String, enum: FILE_BACKEND, required: true },
  drive_file_id: String,          // when backend = drive
  folder_path: String,            // human path inside the Drive root, e.g. CHI-ITI/CHI-ITI-RPLAVP-DST-03/evidence
  entity: String, entity_id: Schema.Types.ObjectId, // what this file is about (batch/trainer/candidate/...) when known
  uploaded_by: { type: Schema.Types.ObjectId, ref: "User" },
  // -87 (QA-157): what the one door did — original vs stored bytes and the label of the pass
  // ("image-1600-q75", "pdf-gs-ebook", "none:gs unavailable"…). Answers "did it compress?"
  // per file, and makes the storage estimate honest.
  original_size: Number,
  compressed: { type: Boolean, default: false },
  compression: String,
  compression_ms: Number,
  needs_compression: { type: Boolean, default: false },
  // -90: direct-to-Drive (resumable) uploads live as "pending" between intent and complete;
  // "ready" is the only state /api/files serves; abandoned pendings are swept to "failed".
  status: { type: String, enum: ["ready", "pending", "failed", "deleted"], default: "ready" }, // -97: deleted = object gone, row kept for audit
  deleted_at: Date, deleted_by: { type: Schema.Types.ObjectId, ref: "User" },
  bytes_expected: Number,
  drive_folder_id: String,
  expires_at: Date,
  // -108: a certificate uploaded for the mapping PREVIEW and not yet attached to anyone. The
  // preview stores the bytes once so the operator does not re-pick 30 files after correcting a
  // mapping; this flag is what lets the next preview find and discard an abandoned batch of them.
  // Cleared the moment the file lands on a result row.
  staged_certificate: { type: Boolean, default: false },
}, { timestamps: true });
StoredFileSchema.index({ entity: 1, entity_id: 1 });
StoredFileSchema.index({ status: 1, expires_at: 1 });
StoredFileSchema.index({ entity_id: 1, staged_certificate: 1 });

// ---------- Public tokens (2026-08-11: self-registration + candidate feedback) ----------
// Capability URLs: the random token IS the credential. register tokens are per-location
// (Admin/Ops generate and share); feedback and attendance tokens are per batch-member
// (attendance added 2026-08-13: "bacche puchte hain sir mera kitna ho gaya attendance" —
// each student gets a link showing their own days/hours/eligibility, nobody else's).
// trainer_apply added 2026-08-14 (CEO: "Add Trainer ke fields as a form uske paas chala
// jaye, wo khud bhar de — Divya naam-email-phone dale, link WhatsApp/SMS chala jaye").
// email_otp added 2026-08-16 (QA-116, CEO's "one of the two" enrolment paths + Umesh: email-OTP
// ab feasible, mail live hai): a walk-in candidate with no link proves they own an email, then
// registers through the same field set the link path uses.
// plan added 2026-08-15 (QA-152 part 2, Umesh): the batch's backward plan as a shareable
// artifact — "jaise self-registration form open hota hai" — the creator edits, the person
// holding the link reads, and (only when the link was minted with allow_updates) ticks status.
export const PUBLIC_TOKEN_PURPOSE = ["register", "feedback", "attendance", "trainer_apply", "email_otp", "phone_otp", "plan"] as const; // -110: phone_otp = the same challenge over SMS
const PublicTokenSchema = new Schema({
  token: { type: String, required: true, unique: true },
  purpose: { type: String, enum: PUBLIC_TOKEN_PURPOSE, required: true },
  location: oid("Location"),    // register: which location's pool the candidate lands in
  program: oid("Program"),      // register: optional preselected program
  batch_member: oid("BatchMember"), // feedback: who this link belongs to
  trainer: oid("Trainer"),      // trainer_apply: the pre-created profile this link completes
  batch: oid("Batch"),          // plan: which batch's plan this link opens (attendance links also set it)
  allow_updates: { type: Boolean, default: false }, // plan: the link holder may tick milestones
  // email_otp / phone_otp: the challenge state. Only the HASH of the code is stored; 10-minute
  // expiry; 5 wrong attempts burn the token. -110: phone_otp proves a mobile number instead.
  email: String,
  phone: String,
  otp_hash: String,
  otp_expires_at: Date,
  otp_attempts: { type: Number, default: 0 },
  otp_verified: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  // REQ-392 (QA-557): a plan share belongs to a PERSON, not only to a batch. Without this the
  // system cannot answer "who has what", because it never recorded who it was for - and worse,
  // it cannot tell one recipient's link from another's when revoking (REQ-393 / QA-558).
  //
  // The recipient is COPIED, not referenced. `Location.contacts[]` is an editable free-text array;
  // if the admin later renames or removes a contact, a link already in someone's hands must still
  // say who it was sent to. `recipient_ref` records where it came from for the UI's benefit only.
  // `role_label` is free text by design (the 2026-08-11 meeting made it so) and REQ-394 requires an
  // unrecognised label to degrade to read-only-everything, never to an empty page.
  recipient_name: String,
  recipient_phone: String,
  recipient_role_label: String,
  recipient_ref: String,        // "spoc" | "principal" | "cluster_head" | "contact:<index>"
  // QA-558 / QA-621 cycle 5: the centre's OWN record of who occupied `recipient_ref` at the moment
  // this link was minted, read server-side (occupantName() in lib/rules.ts) - never the name the
  // caller sent. `recipient_name` above is what the sender saw and is therefore an INPUT; this is
  // what the identity in `recipient_key` was built from, and is therefore EVIDENCE. A ref says
  // which chair; this says who was sitting in it, which is the half that made a slot reassignment
  // (spoc_name edited, a contact row typed over) revoke a different person's live link five
  // releases running.
  recipient_occupant: String,
  // QA-1503 (cycle 2): WHICH CENTRE the ref above was read off, at mint time. `spoc` names a role
  // on whatever centre the batch sat on that day, and the generation counters are per-Location and
  // both start at 0 - so the SPOC of centre X and the SPOC of centre Y produced a BYTE-IDENTICAL
  // key whenever their names matched. `PATCH /api/batches/[id] {location}` moves a batch between
  // centres and is an ordinary supported operation; after it, the new centre's mint revoked the old
  // centre's SPOC's live link, with no rename and no missed bump anywhere. Nor is the name
  // collision exotic: `admin/avpl-rebase` forward-fills the master sheet's SPOC column, so
  // consecutive centres in one import inherit the SAME spoc_name, and the Locations screen ships a
  // SPOC directory whose whole purpose is one SPOC across many centres.
  //
  // Stored as EVIDENCE for the same reason as `recipient_occupant`: the key must be rebuildable
  // from the row's own record, never from where the batch happens to sit today.
  recipient_location: oid("Location"),
  // QA-611: WHO this link belongs to, as one stored value - see recipientKey() in lib/rules.ts.
  // -191 revoked on the phone string and a centre with one landline for two people put the S1
  // straight back; a phone number is not a person.
  // QA-558 / QA-621 cycle 5: that value is now TWO independent signals ANDed together - the durable
  // ref (with the slot's generation) and the occupant snapshot above - so a wrongful revocation
  // needs both to fail at once, in the same direction, rather than either one of them.
  recipient_key: String,
  created_by: oid("User"),
}, { timestamps: true });
PublicTokenSchema.index({ purpose: 1, location: 1 });
PublicTokenSchema.index({ purpose: 1, batch_member: 1 });
// REQ-393: revocation is scoped to (batch, recipient), never to the batch alone.
PublicTokenSchema.index({ purpose: 1, batch: 1, recipient_key: 1 });

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
  // 2026-08-14 (CEO recorded review [35:07]): "we should be able to give them additional
  // rights OR REMOVE the rights" — a per-user deny list. Deny wins over both the role's
  // toggled set and any extra grant. Meaningless on an Admin (role bypasses all checks).
  revoked_permissions: { type: [String], default: [] },
  // 15/08 (Umesh): user DROP is soft — the row stays so logs and created-by history keep
  // their names, but the login dies and the email is renamed to dropped.<ts>.<email> so
  // the unique index frees up ("drop karke naya create kar sakte hain"). dropped_email
  // keeps the original address for display.
  dropped: { type: Boolean, default: false },
  dropped_email: String,
}, { timestamps: true });

// ---------- RolePermission (2026-08-11, CEO: AWS-style group toggles) ----------
// One document per role = the "group". Admin toggles which feature-rights the role carries;
// enforcement = (role's toggled set ∪ the user's extra_permissions) − revoked_permissions
// (Admin bypasses all).
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
// QA-137: the per-user activity view queries by actor — without this it is a collection scan.
AuditLogSchema.index({ actor: 1, created_at: -1 });

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
  // -164: Karunn sir's column 14, "Date for Trainer Mapping on SIDH Portal?". It is a lead time
  // like the seven above and NOT hard-coded, per the planner contract §3 — the portal step sits
  // between TOT completion and mobilisation, because a trainer cannot be mapped before they are
  // certified and candidates should not be mobilised for a batch with no mapped trainer.
  lead_trainer_mapped_sidh_days: { type: Number, default: 2 }, // QA-503: 5 put it BEFORE tot_done (3)
  min_daily_evidence: { type: Number, default: 2 },
  // -87 (QA-157): media compression knobs — Umesh turns them after eyeballing one clip/scan.
  image_max_px: { type: Number, default: 1600 },
  image_quality: { type: Number, default: 75 },
  pdf_compress: { type: Boolean, default: true },
  // -91 (Umesh: "pehle compress, phir upload — highest compression, par chehre pehchane
  // jaayen"): video is compressed ON THE DEVICE before it travels; these are the targets.
  video_compress: { type: Boolean, default: true },
  video_max_height: { type: Number, default: 720 },
  video_bitrate_kbps: { type: Number, default: 1500 },
  video_audio_kbps: { type: Number, default: 64 },
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
  // QA-144: the CEO's 8-hour rule — a trainer's slotted batches may not total more than this
  // many teaching hours on any overlapping day. Counted from slots only; unslotted batches
  // stay governed by the concurrency cap alone (same stance as the time-clash check).
  max_daily_hours: { type: Number, default: 8 },
  // 2026-08-13 (Manish): "60 plus hona mandatory hai" — minimum attendance, as a percent of
  // programme hours, to qualify for the assessment. Contract-tunable like the counters below.
  min_attendance_pct: { type: Number, default: 50 },
  // R-J (QA-049): Rule 54 — enrollment completion requires a recorded fee payment. OFF by
  // default (government-funded schemes charge the candidate nothing). NOTE: this schema is
  // strict — a toggle missing here is silently dropped by $set, which is exactly the bug
  // the probe caught on 14/08.
  fee_required_for_enrollment: { type: Boolean, default: false },
  // QA-115 (2026-08-15): admin kill-switch for outbound email — the real gate is the SES
  // env creds. Same strict-schema warning as above: omit here = writes silently dropped.
  email_enabled: { type: Boolean, default: true },
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
export const MailLog = models.MailLog || model("MailLog", MailLogSchema);
export const StoredFile = models.StoredFile || model("StoredFile", StoredFileSchema);
export const ApprovalRule = models.ApprovalRule || model("ApprovalRule", ApprovalRuleSchema);
export const ApprovalRequest = models.ApprovalRequest || model("ApprovalRequest", ApprovalRequestSchema);
export const AuditLog = models.AuditLog || model("AuditLog", AuditLogSchema);
export const CostCategory = models.CostCategory || model("CostCategory", NamedActiveSchema);
export const DropReason = models.DropReason || model("DropReason", (NamedActiveSchema as any).clone?.() ?? NamedActiveSchema);
export const FailureReason = models.FailureReason || model("FailureReason", (NamedActiveSchema as any).clone?.() ?? NamedActiveSchema);
// QA-118/119 (CEO, 15/08): editable masters instead of hardcoded strings. The SCHEME
// master carries the money-and-hours facts (Manish fills the data; the STRUCTURE is what
// unblocks QA-093's honest assessment threshold). Scheme names mirror the SCHEME enum —
// the enum stays the write-guard on Program.scheme; this master holds each scheme's facts.
const SchemeSchema = new Schema({
  name: { type: String, required: true, unique: true },
  code: String,
  total_hours: Number,          // QP total hours for the scheme's programmes
  min_required_hours: Number,   // minimum attended hours to sit the assessment
  amount_received: Number,      // what the client pays per certified candidate (₹)
  active: { type: Boolean, default: true },
}, { timestamps: true });
const JobRoleSchema = new Schema({
  name: { type: String, required: true, unique: true },
  code: String,
  active: { type: Boolean, default: true },
}, { timestamps: true });
export const Scheme = models.Scheme || model("Scheme", SchemeSchema);
export const JobRole = models.JobRole || model("JobRole", JobRoleSchema);
export const CandidateDocument = models.CandidateDocument || model("CandidateDocument", CandidateDocumentSchema);
export const BatchDocument = models.BatchDocument || model("BatchDocument", BatchDocumentSchema);
export const Defaults = models.Defaults || model("Defaults", DefaultsSchema);

export { mongoose };
