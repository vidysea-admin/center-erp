import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { Types } from "mongoose";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError, isScoped, readFormData, translateError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BatchMember, Candidate, EDUCATION_LEVEL, Location, Program, SIDH_STATUS } from "@/models";
import { assertBatchJoinable, assignCandidateToBatch, candidateEligibility, joinRefusalFor, parseSheetDate, rule20Sentence } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { plain } from "@/lib/user-copy";
import { CANDIDATE_IMPORT_FIELDS } from "@/lib/field-catalog";
import { readUploadedWorkbook } from "@/lib/workbook";
import { audit } from "@/lib/audit";
import { findDuplicateCandidates, normalizePhone } from "@/lib/duplicates";
import { canonicalAadhaar, canonicalApaar, canonicalPhone, sameGovtNumber } from "@/lib/validate";
import { personLabel } from "@/lib/person";
import { coerceBatchInterest } from "@/lib/candidate-journey";
import { looksLikeCan, normalizeCan } from "@/lib/govt-attendance";

// -154 (QA-424, REQ-385): the SET of importable fields comes from the catalog; the HANDLING stays
// deliberate. Deriving behaviour from a type would have quietly changed how existing fields are
// coerced (gender is "enum" in the catalog and has always been written as free text here), so the
// two are kept apart: the catalog decides WHAT may be mapped, these sets decide HOW, and any field
// the catalog offers that no branch handles is REPORTED rather than dropped (QA-426).
const TEXT_IMPORT_FIELDS = new Set(
  CANDIDATE_IMPORT_FIELDS.filter((f) => f.type === "text" || f.type === "phone" || f.type === "enum")
    .map((f) => f.key)
    // QA-1191: batch_interest joins the two that are COERCED rather than taken as text. It was in
    // this set, so a sheet cell went in verbatim and mongoose's enum validator then killed the whole
    // insertMany - preview 200, confirm 400, zero rows written. Measured, not assumed.
    .filter((k) => k !== "education" && k !== "sidh_status" && k !== "batch_interest"),
);
const HANDLED_IMPORT_FIELDS = new Set<string>([
  ...TEXT_IMPORT_FIELDS,
  "dob", "last_training_date",          // parsed by parseSheetDate
  // QA-1233 (checker, qa-1191 cycle 1): batch_interest belongs HERE the moment it left
  // TEXT_IMPORT_FIELDS, and cycle 1 took it out of one set without adding it to the other. The cost
  // was precise and backwards: every import that mapped the interest column started reporting
  // `unhandled_fields: ["batch_interest"]` - the QA-426/REQ-379 lane announcing "accepted and
  // discarded" about the ONE column this unit exists to handle, while education beside it returned
  // []. A fix that makes the honesty lane lie about itself.
  "education", "sidh_status", "batch_interest",   // coerced against their enum
  "interested_programs", "interested_locations", // resolved by name
]);

const CAN_SHAPE = /CAN/i;

// Excel import: upload → map → preview → confirm (screen spec).
// POST multipart: file, location, program, mapping (JSON {excelCol: name|phone|alt_phone|gender|source}), confirm ("1" to write)
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.manage"); // togglable (2026-08-11)
  const form = await readFormData(req, "multipart form-data body required — attach the sheet as 'file'");
  const file = form.get("file") as File | null;
  const location = String(form.get("location") || "");
  const program = String(form.get("program") || "");
  const confirm = form.get("confirm") === "1";
  const mappingRaw = form.get("mapping");
  // qa-import-into-batch (-325): the OPTIONAL "Add to batch" field. Absent = no code path of the existing
  // importer changes (D1). Present = importing AND assigning, so BOTH rights are required, enforced here
  // on the server whatever the screen hides. Everything below that can refuse a batch-level problem runs
  // BEFORE the workbook is read, so a refusal has written nothing.
  const batchId = String(form.get("batch") || "");
  if (batchId) await requirePerm(user, "candidates.assign");
  if (!file) throw new HttpError(400, "file is required");
  if (!location || !program) throw new HttpError(400, "location and program are required");
  assertLocationInScope(user, location);
  let joinBatch: Awaited<ReturnType<typeof assertBatchJoinable>> | null = null;
  if (batchId) {
    joinBatch = await assertBatchJoinable(user, batchId); // 404 / Rule 38 scope / closed / Rule 1
    // Admin and Operations pass the scope test trivially, so this equality is the real centre guard for
    // them - the same reason batches/[id]/members states it explicitly.
    if (String(joinBatch.location) !== location || String(joinBatch.program) !== program) {
      throw new HttpError(409, "That batch is not at this location / job role.");
    }
  }

  const buf = Buffer.from(await file.arrayBuffer());
  // QA-1023: CSV date cells are coerced US-style at READ time; readUploadedWorkbook keeps them as
  // text so parseSheetDate can apply the template's own DD-MM-YYYY rule. See lib/workbook.ts.
  const wb = readUploadedWorkbook(buf, file.name);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length) throw new HttpError(400, "Sheet is empty");
  const columns = Object.keys(rows[0]);

  if (!mappingRaw) {
    // step 1: return columns + preview for mapping UI
    return NextResponse.json({ columns, preview: rows.slice(0, 5), total: rows.length });
  }
  const mapping: Record<string, string> = JSON.parse(String(mappingRaw));
  const nameCol = Object.keys(mapping).find((c) => mapping[c] === "name");
  const phoneCol = Object.keys(mapping).find((c) => mapping[c] === "phone");
  if (!nameCol || !phoneCol) throw new HttpError(400, "Mapping must include name and phone");

  // 15/08 (Umesh): columns the mapping doesn't know are NOT restricted away — the preview
  // names them and, when the operator accepts, each row's values land in custom_fields
  // under the sheet's own column name (stringified, 500-char cap).
  const unknownCols = columns.filter((c) => !mapping[c]);
  const acceptUnknown = form.get("accept_unknown") === "1";

  // F-B4 (Manish): the eligibility fields arrive with the sheet — dob, education,
  // last training date. Education is matched against the enum case-insensitively;
  // a spelling we don't recognise stays null and is REPORTED, never guessed.
  // Interest fields (comma-separated centre / job-role NAMES) resolve the same way.
  const eduUnmatched: string[] = [];
  const sidhStatusUnmatched: string[] = [];
  // QA-1191: NOT `interestUnmatched` below - that one collects unresolved programme and centre NAMES
  // for interested_programs/interested_locations. Same word, different question.
  const batchInterestUnmatched: string[] = [];
  const interestUnmatched: string[] = [];
  // QA-097: a date the parser cannot read is REPORTED against its row, never dropped.
  const dateUnparseable: string[] = [];
  // -154 (QA-415 / QA-426, REQ-379): a mapped field this writer cannot handle used to be dropped in
  // silence - not written, and not captured into custom_fields either, because a KNOWN field never
  // reaches the unknown-column path. sidh_candidate_id was the live instance: the operator could
  // fill the column correctly and lose it without a word, which is the worst of the three outcomes
  // because it looks like success.
  const unhandledFields: string[] = [];
  // -154 (Umesh: "blank ko accept hi kyun kar raha hai, it should ask"). Requiring a value would be
  // wrong - sidh_status defaults to "Not Registered" because a candidate exists in the ERP BEFORE
  // the government portal registers them, so a fresh roster legitimately carries no portal ID at
  // all; demanding one would block every normal import. But he is right about the other half: if
  // the operator MAPPED a column and the cells are blank, that is worth saying out loud. It is the
  // shape of a mis-aligned column, a stale sheet, or a partial file - which is exactly how 55
  // portal IDs went missing. So: never blocked, always reported, per mapped column, for EVERY
  // field rather than a special case for the one that hurt (a column mapped to phone that comes
  // back 100% blank is the same defect wearing a different name).
  const blankByField: Record<string, number> = {};
  const needsInterest = Object.values(mapping).some((f) => ["interested_programs", "interested_locations"].includes(f));
  const progByName = new Map<string, any>();
  const locByName = new Map<string, any>();
  if (needsInterest) {
    for (const p of await Program.find({}).select("name").lean<any[]>()) {
      const k = String(p.name).trim().toLowerCase();
      progByName.set(k, progByName.has(k) ? null : p._id); // ambiguous name → null → unmatched
    }
    for (const l of await Location.find({}).select("name").lean<any[]>()) {
      const k = String(l.name).trim().toLowerCase();
      locByName.set(k, locByName.has(k) ? null : l._id);
    }
  }
  const resolveNames = (raw: string, map: Map<string, any>) => {
    const ids: any[] = [];
    for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const id = map.get(part.toLowerCase());
      if (id) ids.push(id);
      else interestUnmatched.push(part);
    }
    return ids;
  };
  // qa-import-into-batch: sheet row number (header = row 1) for each candidate object, kept OUTSIDE the
  // object so it can never ride into insertMany.
  const rowNoOf = new WeakMap<object, number>();
  const mapped = rows
    .map((r, rowIdx) => {
      const c: Record<string, unknown> = { location, program, lifecycle_status: "Unassigned", created_by: user.id };
      rowNoOf.set(c, rowIdx + 2);
      for (const [col, field] of Object.entries(mapping)) {
        // -154 (QA-415, S1 QA-414): sidh_candidate_id joins the plain-text fields. It is the field
        // the government attendance matcher AND the certificate matcher join on, and this door -
        // which is how rosters actually arrive - was the one door that would not write it.
        if (TEXT_IMPORT_FIELDS.has(field)) {
          // -154 (QA-417): an EMPTY cell must not become an empty STRING. The new unique index on
          // sidh_candidate_id is partial on $type: "string", and "" is a string - so two rows with
          // a blank Candidate ID column would collide and the second insert would be refused. A
          // blank cell means "not known", which is null, not "". True of every text field here;
          // sidh_candidate_id is only the one where it now bites.
          const v = String(r[col] ?? "").trim();
          if (v) c[field] = v;
        }
        // QA-1234 (checker, qa-1191 cycle 1): counted off the MAPPING, for every mapped column,
        // before any per-field branching. It used to live inside the text branch above, so the
        // moment batch_interest moved out of that branch its all-blank column stopped being
        // reported - silently, while the comment on the screen block still promised "per column,
        // so a phone column that comes back all-blank is caught by the same line". The same hole
        // was always there for dob, education and sidh_status; this closes it for all of them.
        // QA-1267 (checker, cycle 2): `field` can be the EMPTY STRING - that is exactly what the
        // drawer's own "Ignore" option writes (page.tsx:1193 posts e.target.value, and :519
        // remembers it), so an operator who maps a column and then sets it back to Ignore got a
        // preview warning in the amber "probably mis-mapped" styling reading "2 of 2 rows have
        // nothing in the column mapped to ." - naming no column at all. Which is this cycle's own
        // charge repeated one line further down: a report lane saying something untrue about a
        // column. Guard the key, not just the value.
        if (field && !String(r[col] ?? "").trim()) blankByField[field] = (blankByField[field] ?? 0) + 1;
        if (["dob", "last_training_date"].includes(field) && r[col] !== "" && r[col] != null) {
          // QA-097/098: DD-MM-YYYY (the template's own format), ISO and Excel serials all
          // parse; anything else is named by row — new Date() read "05-06-2001" as May 5th
          // and dropped "15-06-2001" without a word.
          const d = parseSheetDate(r[col]);
          if (d) c[field] = d;
          else dateUnparseable.push(`row ${rowIdx + 2}: ${field} "${String(r[col])}"`);
        }
        if (field === "education" && r[col]) {
          const raw = String(r[col]).trim();
          const match = EDUCATION_LEVEL.find((e) => e.toLowerCase() === raw.toLowerCase());
          if (match) c.education = match;
          else if (raw) eduUnmatched.push(raw);
        }
        // -154: offered by the catalog, so it is written rather than dropped (REQ-379). Coerced
        // against the enum exactly as education is - an unrecognised value is REPORTED, never
        // guessed at, because this field says whether the government has registered a student.
        if (field === "sidh_status" && r[col]) {
          const raw = String(r[col]).trim();
          const match = SIDH_STATUS.find((e) => e.toLowerCase() === raw.toLowerCase());
          if (match) c.sidh_status = match;
          else if (raw) sidhStatusUnmatched.push(raw);
        }
        // QA-1191: coerced exactly as education and sidh_status above are, and REPORTED when it is
        // not a spelling we know. Unset is the safe failure: the schema default is "Current", so an
        // unreadable cell leaves that person enrollable rather than silently frozen out of every batch.
        if (field === "batch_interest" && r[col]) {
          const raw = String(r[col]).trim();
          const match = coerceBatchInterest(raw);
          if (match) c.batch_interest = match;
          else if (raw) batchInterestUnmatched.push(raw);
        }
        if (field === "interested_programs" && r[col]) {
          const ids = resolveNames(String(r[col]), progByName);
          if (ids.length) c.interested_programs = ids;
        }
        if (field === "interested_locations" && r[col]) {
          const ids = resolveNames(String(r[col]), locByName);
          if (ids.length) c.interested_locations = ids;
        }
        // -154 (QA-426, REQ-379): the catalog offers it, so SOMETHING here must handle it. If
        // nothing did, say so - never accept and discard.
        if (field && !HANDLED_IMPORT_FIELDS.has(field)) unhandledFields.push(field);
      }
      if (acceptUnknown && unknownCols.length) {
        const cf: Record<string, string> = {};
        for (const col of unknownCols) {
          const raw = String(r[col] ?? "").trim();
          if (raw) cf[col] = raw.slice(0, 500);
        }
        if (Object.keys(cf).length) c.custom_fields = cf;
      }
      return c;
    });
  // QA-146 part 2 (-83, checker on Umesh's CHI-ITI import): the sheet's own HEADER and
  // DESCRIPTION rows ("Salutation / FullName", "Input field, Mr, Ms, Mrs, Mx *") had been
  // stored as candidates — the only guard was "name and phone are non-empty". This is NOT a
  // format drop on a client row (Umesh's rule stands): a row is a template row only when its
  // phone cell carries no digit at all AND the text reads like a column label / instruction.
  // Skipped rows are named by sheet row number so the operator can see exactly what went.
  const TEMPLATE_TEXT = /salutation|full\s*name|input\s*field|alphanumeric|validation|\bmr\b[\s,\/]*\bms\b|^\s*\*|\(\d+\)\s*\*?$/i;
  const templateRows: string[] = [];
  const looksTemplate = (c: Record<string, unknown>) => {
    const name = String(c.name ?? ""), phone = String(c.phone ?? ""), email = String(c.email ?? "");
    const digits = (phone.match(/\d/g) ?? []).length;
    // the sheet's column-NUMBER row ("1" / "5" / "12"): a bare number as the name and a
    // "phone" with fewer than 4 digits — no client row looks like that (checker, live row 3)
    if (/^\d{1,3}$/.test(name.trim()) && digits < 4 && !/[a-z]/i.test(phone)) return true;
    // 4+ digits = could be a phone someone typed badly → a CLIENT row, never a template row
    // ("Alphanumeric (50)" carries two digits and is still an instruction, not a number)
    if (digits >= 4) return false;
    return TEMPLATE_TEXT.test(name) || TEMPLATE_TEXT.test(phone) || TEMPLATE_TEXT.test(email) || /^email\s*id$/i.test(phone);
  };
  const candidates = mapped.filter((c, i) => {
    if (!(c.name && c.phone)) return false;
    if (looksTemplate(c)) { templateRows.push(`row ${i + 2}: "${String(c.name).replace(/\s+/g, " ").slice(0, 40)}"`); return false; }
    return true;
  });

  // QA-141 (Umesh): canonicalize what we can, REPORT what we cannot — client rows are never
  // dropped over format (the custom_fields ruling), but a valid-shaped number lands as the
  // bare 10 digits so one person cannot become three rows.
  const phoneInvalid: string[] = [];
  for (const c of candidates) {
    for (const f of ["phone", "alt_phone"] as const) {
      if (!c[f]) continue;
      const p = canonicalPhone(c[f]);
      if (p) c[f] = p;
      else if (f === "phone") phoneInvalid.push(personLabel(c));
    }
  }

  // QA-727 (-212, checker on qa-210): the same treatment for the portal Candidate ID, at the door
  // this file's own header calls how rosters actually arrive. -210 hardened the two hand-typed
  // doors and left this one writing any string verbatim - `40918461`, `CANDIDATE`, all of it, 201,
  // no warning - and excused it in a comment naming a "normalize-and-report lane" that did not
  // exist for this field. `phone_invalid` two lines up is the proof that per-row format reporting
  // already lives here; the field simply was never given it.
  //
  // REPORT, never refuse: a client's sheet is client data and the QA-141 ruling is that rows are
  // not dropped over format. What is unacceptable is doing it SILENTLY, because the value then
  // blocks the automatic linker for that student forever - link-portal-ids only ever fills an EMPTY
  // id - and nothing ever said so. Trimmed on the way in for the same reason as the typed doors
  // (QA-730): the partial unique index is built on the raw string.
  const candidateIdInvalid: string[] = [];
  for (const c of candidates) {
    if (typeof c.sidh_candidate_id !== "string") continue;
    const raw = c.sidh_candidate_id.trim();
    if (!raw) { delete c.sidh_candidate_id; continue; } // QA-450: absent, not "" - the index indexes ""
    c.sidh_candidate_id = raw;
    if (!looksLikeCan(raw)) candidateIdInvalid.push(`${personLabel(c)} — "${raw}"`);
    else if (!normalizeCan(raw)) candidateIdInvalid.push(`${personLabel(c)} — "${raw}" (stored, but certification cannot read it — the ID must be CAN followed by the number)`);
  }

  // QA-941 (2026-08-24, qa-233 checker): the Aadhaar number had NO lane here, and the comment in
  // lib/validate.ts asserted it did — "bulk import keeps the normalize-and-report lane". Measured by
  // the checker: a checksum failure AND the literal string "NOT-AN-AADHAAR" both imported silently,
  // 201, no warning. That is QA-727 repeating one release later, on a field that is worse to get
  // wrong: QA-942 traces it straight through to the government SIDH export, which ships whatever is
  // on the record.
  //
  // REPORT, never refuse — the QA-141 ruling stands, a client's sheet is client data and rows are not
  // dropped over format. What is unacceptable is silence, because the operator then has no moment at
  // which they could have known.
  //
  // NORMALIZE what we can first: "2341 2341 2346" and "2341-2341-2346" are how a person writes a
  // 12-digit number, and refusing those would report a fault the sheet does not have.
  const aadhaarInvalid: string[] = [];
  for (const c of candidates) {
    if (typeof c.aadhaar_no !== "string") continue;
    const raw = c.aadhaar_no.trim();
    if (!raw) { delete c.aadhaar_no; continue; } // absent, never "" on the record
    const canon = canonicalAadhaar(raw);
    if (canon) { c.aadhaar_no = canon; continue; }
    // Stored as given (never dropped), and NAMED so the operator sees it on the preview.
    c.aadhaar_no = raw;
    // QA-971 (qa-233 checker, cycle 2): this sentence used to end "the SIDH export will carry it
    // as-is" — and QA-942, IN THE SAME COMMIT, made the export carry nothing. I contradicted my own
    // fix in the message the operator actually reads, and it reached master. The words now say what
    // the code does, and they say the CONSEQUENCE rather than the mechanism: what an operator needs
    // to know is that this student will go to SIDH without an Aadhaar unless somebody fixes it.
    aadhaarInvalid.push(`${personLabel(c)} — "${raw}" (stored as given, but it is not a readable Aadhaar number, so the SIDH export will leave that column BLANK for this student until it is corrected)`);
  }

  // QA-902 (2026-08-24): the same lane for the government APAAR ID, given to it at the same time as
  // the field rather than a release later — QA-727 is the row that records what "we will add the
  // guard to the importer afterwards" actually costs.
  //
  // NORMALIZE what we can: "1903 0551 6076" and "1903-0551-6076" are how a 12-digit number gets
  // typed into a spreadsheet, and they are not errors. Storing the canonical form also matters more
  // here than it looks — the partial unique index is built on the RAW string (QA-730), so without
  // this the spaced and unspaced spellings of one person's APAAR would not collide with each other.
  //
  // REPORT, never refuse (QA-141): a client's sheet is client data. What is unacceptable is silence.
  const apaarInvalid: string[] = [];
  const apaarSeen = new Map<string, string>();
  const apaarDuplicate: string[] = [];
  const apaarSameAsAadhaar: string[] = [];   // QA-949
  for (const c of candidates) {
    if (typeof c.apaar_id !== "string") continue;
    const raw = c.apaar_id.trim();
    if (!raw) { delete c.apaar_id; continue; } // QA-450: absent, not "" - the index indexes ""
    const canon = canonicalApaar(raw);
    c.apaar_id = canon ?? raw;
    if (!canon) apaarInvalid.push(`${personLabel(c)} — "${raw}" (stored, but it is not a 12-digit APAAR ID)`);
    // An APAAR belongs to one student, and the field carries a unique index — so two rows of ONE
    // sheet holding the same number would make `insertMany` below fail as a whole, taking the other
    // 44 good rows with it. Said on the preview, where it can still be fixed in the sheet.
    //
    // QA-948 (-232 cycle 1, checker): this used to sit behind `if (!canon) … continue`, so the
    // detector skipped exactly the case IT created. An unreadable value is still STORED (the line
    // above writes `canon ?? raw`) and the partial index is on `$type: "string"`, so it indexes any
    // string — two rows carrying the same UNREADABLE APAAR therefore collided at insertMany with
    // nothing said on the preview. Measured by the checker on a 20-row sheet: preview reported
    // apaar_duplicate_count=0, confirm answered a bare 409, and **3 of 20 rows landed — 17 lost**,
    // with no `imported` count to reveal that a partial import had happened at all.
    // So the key is what actually goes into the DOCUMENT (`canon ?? raw`), not the readable subset.
    const key = canon ?? raw;
    const twin = apaarSeen.get(key);
    if (twin) apaarDuplicate.push(`${personLabel(c)} — "${key}" is also on ${twin}`);
    else apaarSeen.set(key, personLabel(c));
    // QA-949 (-232 cycle 1, checker): the QA-414 guard was on the two hand-typed doors and NOT here
    // — so the importer, which is how rosters actually arrive, stored apaar_id === aadhaar_no
    // without a word. That is the exact defect the guard is named after, missing from the exact door
    // where it happened. REPORTED, never refused (QA-141: a client's sheet is never dropped over
    // format), which is the same posture every other check in this loop takes.
    // QA-977: equality, not validity - the importer had the same hole as the three typed doors.
    if (sameGovtNumber(key, (c as any).aadhaar_no)) {
      apaarSameAsAadhaar.push(`${personLabel(c)} — "${key}" is this candidate's Aadhaar number, not their APAAR ID`);
    }
  }

  // QA-991: apaarSeen/candidateIdInvalid above only ever caught trouble WITHIN this one sheet -
  // a value that already belongs to ANOTHER candidate already in the database was invisible to
  // every one of the four APAAR report lists (all stayed empty, HTTP 200) and confirm crashed
  // insertMany on the database's own unique index partway through, silently dropping every row
  // after it (measured: 9 of 20 landed, 11 lost, no `imported` field to reveal a partial write
  // had even happened). The Closure card's own single-candidate door (results/route.ts:160) has
  // carried this exact pre-check for a while; the bulk importer, the door 45 students at a time
  // actually arrive through, never did.
  //
  // Unlike an unreadable value (harmless to store as given - QA-902/QA-941's own posture), a
  // value that already belongs to someone else is WRONG to store: it would misattribute a real
  // government identity, and the database would refuse the write anyway. So this is the one field
  // in this file that is DROPPED rather than stored-as-given - QA-141's "a row is never dropped
  // over format" still holds, because it is the FIELD that is dropped, not the row.
  const apaarTaken: string[] = [];
  // qa-import-into-batch (-325): with a batch chosen, a row whose portal ID is already held is NOT inserted
  // as a new candidate - that is the duplicate-creation path this feature closes. It is recorded here with
  // the holder document and resolved further down. Without a batch nothing below changes (QA-991).
  type HolderHit = { matched_on: "apaar" | "sidh"; value: string; holder: any };
  const holderHits = new Map<object, HolderHit[]>();
  const addHit = (c: object, h: HolderHit) => { const l = holderHits.get(c) ?? []; l.push(h); holderHits.set(c, l); };
  const HOLDER_FIELDS = " phone location program archived_at batch_interest dob education last_training_date";
  if (apaarSeen.size) {
    const holders = await Candidate.find({ apaar_id: { $in: [...apaarSeen.keys()] } }).select("name apaar_id" + (joinBatch ? HOLDER_FIELDS : "")).lean<any[]>();
    const byKey = new Map(holders.map((h) => [String(h.apaar_id), h]));
    for (const c of candidates) {
      if (typeof c.apaar_id !== "string") continue;
      const holderDoc = byKey.get(c.apaar_id);
      if (!holderDoc) continue;
      if (joinBatch) { addHit(c, { matched_on: "apaar", value: c.apaar_id, holder: holderDoc }); continue; }
      const holder = holderDoc.name;
      apaarTaken.push(`${personLabel(c)} — "${c.apaar_id}" is already the APAAR ID of ${holder}`);
      delete c.apaar_id;
    }
  }

  // The identical gap exists on the portal Candidate ID (QA-991's own text: "bilkul yahi gap hai").
  // Matched the same way every other screen already reads it (QA-447): "CAN_5302339001",
  // "CAN5302339001" and "can 5302339001" are one government identity, not three.
  const sidhTaken: string[] = [];
  {
    const wanted = new Set<string>();
    for (const c of candidates) {
      if (typeof c.sidh_candidate_id !== "string") continue;
      const canon = normalizeCan(c.sidh_candidate_id);
      if (canon) wanted.add(canon);
    }
    if (wanted.size) {
      const holders = await Candidate.find({ sidh_candidate_id: CAN_SHAPE }).select("name sidh_candidate_id" + (joinBatch ? HOLDER_FIELDS : "")).lean<any[]>();
      const byCanon = new Map<string, any>();
      for (const h of holders) {
        const hc = normalizeCan(h.sidh_candidate_id);
        if (hc && wanted.has(hc) && !byCanon.has(hc)) byCanon.set(hc, h);
      }
      for (const c of candidates) {
        if (typeof c.sidh_candidate_id !== "string") continue;
        const canon = normalizeCan(c.sidh_candidate_id);
        const holderDoc = canon ? byCanon.get(canon) : undefined;
        if (!holderDoc) continue;
        if (joinBatch) { addHit(c, { matched_on: "sidh", value: c.sidh_candidate_id, holder: holderDoc }); continue; }
        const holder = holderDoc.name;
        sidhTaken.push(`${personLabel(c)} — "${c.sidh_candidate_id}" is already recorded for ${holder} (the same government identity, written differently)`);
        delete c.sidh_candidate_id;
      }
    }
  }

  // Rule 7: the import path is where bulk duplicates actually enter. Flag them, never block —
  // the operator decides. Checks both against existing records and within the file itself.
  const seen = new Map<string, number>();
  const inFile: string[] = [];
  for (const c of candidates) {
    const key = normalizePhone(c.phone);
    if (!key) continue;
    if (seen.has(key)) inFile.push(`${personLabel(c)} — same number as row ${seen.get(key)! + 1} in this file`);
    else seen.set(key, candidates.indexOf(c));
  }
  const existingHits: string[] = [];
  const existingHitOf = new Map<object, string>();
  // QA-2930 (Rule 38): a Location-scoped importer is told about look-alikes at THEIR centres in full, exactly
  // as before. A look-alike at a centre they cannot see is still flagged - so they ask an Admin - but with
  // no name, phone or centre. The scope goes into the query (findDuplicateCandidates' locationScope, the
  // same argument check-duplicate passes), never a post-filter: the hit carries a centre NAME.
  const dupScope = isScoped(user) ? (user.location_scope ?? []).map(String) : undefined;
  for (const c of candidates.slice(0, 300)) { // bounded: preview only, not a full-file scan
    const probe = { name: String(c.name), phone: String(c.phone), dob: c.dob as Date };
    // an empty scope means "sees nothing": findDuplicateCandidates treats [] as unscoped, so never pass it
    const hits = dupScope && !dupScope.length ? [] : await findDuplicateCandidates(probe, undefined, dupScope);
    if (hits.length) {
      const msg = `${personLabel(c)} → already exists: ${hits[0].message}`;
      existingHits.push(msg);
      existingHitOf.set(c, msg);
    } else if (dupScope && (await findDuplicateCandidates(probe)).length) {
      const msg = `${personLabel(c)} → a possible duplicate exists at a centre you cannot see. Ask an Admin to check before you import.`;
      existingHits.push(msg);
      existingHitOf.set(c, msg);
    }
  }
  let duplicates = [...inFile, ...existingHits];

  // ============ qa-import-into-batch (-325): batch mode - resolve every sheet row into ONE of ============
  //   new (inserted, then offered to the batch) | holder row (an existing candidate already holds its APAAR /
  //   portal ID: NEVER inserted, offered to the batch only if the operator ticks it) | ambiguous (two
  //   different holders: neither). Runs for the preview AND the commit, so the commit re-derives every
  //   fact from the database instead of trusting what the screen showed a minute ago (arm 12).
  let toInsert: Record<string, unknown>[] = candidates;
  type HolderRow = {
    row: number; label: string; value: string; matched_on: "apaar" | "sidh"; holderId: string;
    holder: any; inScope: boolean; refusal: string | null; warning?: string; dupOfRow?: number;
  };
  const holderRows: HolderRow[] = [];
  const ambiguousRows: { row: number; label: string; reason: string }[] = [];
  const newRefused: { row: number; label: string; reason: string }[] = [];
  const newWarnings: { row: number; label: string; warning: string }[] = [];
  let rosterCount = 0;
  const joinDefaults = joinBatch ? await getDefaults() : null;
  if (joinBatch && joinDefaults) {
    const jb = joinBatch;
    const held = new Set<object>();
    const claimedBy = new Map<string, number>();
    for (const c of candidates) {
      const hits = holderHits.get(c);
      if (!hits) continue;
      held.add(c);
      const rowNo = rowNoOf.get(c) ?? 0;
      const label = personLabel(c);
      const distinct = [...new Set(hits.map((h) => String(h.holder._id)))];
      if (distinct.length > 1) {
        ambiguousRows.push({ row: rowNo, label, reason: "This row matches two different existing candidates (one by APAAR ID, one by portal Candidate ID), so it was not created and nobody was added for it. Fix the sheet and import again." });
        continue;
      }
      const hit = hits[0];
      const holderId = String(hit.holder._id);
      const inScope = !isScoped(user) || (user.location_scope ?? []).map(String).includes(String(hit.holder.location ?? ""));
      const row: HolderRow = { row: rowNo, label, value: hit.value, matched_on: hit.matched_on, holderId, holder: hit.holder, inScope, refusal: null };
      if (claimedBy.has(holderId)) {
        row.dupOfRow = claimedBy.get(holderId);
        row.refusal = `This is the same existing candidate as row ${row.dupOfRow}, already listed.`;
      } else claimedBy.set(holderId, rowNo);
      holderRows.push(row);
    }
    toInsert = candidates.filter((c) => !held.has(c));

    // holder state: scope, join rules, Rule 20 (one query for all holders), eligibility
    for (const h of holderRows) {
      if (h.refusal) continue;
      if (!h.inScope) { h.refusal = "This ID already belongs to a candidate at a centre you cannot see. Ask an Admin to add them."; continue; }
      const r = joinRefusalFor(h.holder, jb);
      if (r) h.refusal = r;
    }
    const probe = holderRows.filter((h) => !h.refusal).map((h) => h.holder._id);
    if (probe.length) {
      const active = await BatchMember.find({ candidate: { $in: probe }, left_on: null }).select("candidate batch").populate("batch", "code").lean<any[]>();
      const byCand = new Map(active.map((m) => [String(m.candidate), m]));
      for (const h of holderRows) {
        if (h.refusal) continue;
        const m = byCand.get(h.holderId);
        if (m) h.refusal = rule20Sentence((m.batch as any)?.code ?? m.batch);
        else {
          const el = candidateEligibility(h.holder, joinDefaults);
          if (!el.eligible) h.warning = `${h.holder.name ?? "Candidate"}: ${el.reasons.join("; ")}`;
        }
      }
    }
    // new rows: the join rules that can be known before they exist, and the eligibility notes
    for (const c of toInsert) {
      const rowNo = rowNoOf.get(c) ?? 0;
      const r = joinRefusalFor(c as any, jb);
      if (r) { newRefused.push({ row: rowNo, label: personLabel(c), reason: plain(r) }); continue; }
      const el = candidateEligibility(c as any, joinDefaults);
      if (!el.eligible) newWarnings.push({ row: rowNo, label: personLabel(c), warning: `${c.name ?? "Candidate"}: ${el.reasons.join("; ")}` });
    }
    rosterCount = await BatchMember.countDocuments({ batch: jb._id, left_on: null });
    // a row that is a holder is not a "possible duplicate" to flag - the holder table says it better, and
    // for an out-of-scope holder the message would name somebody the user may not see
    const hiddenMsgs = new Set([...held].map((c) => existingHitOf.get(c)).filter(Boolean) as string[]);
    if (hiddenMsgs.size) duplicates = duplicates.filter((m) => !hiddenMsgs.has(m));
  }
  const batchPlan = () => {
    const jb = joinBatch!;
    const willAddNew = toInsert.length - newRefused.length;
    const rosterAfter = rosterCount + willAddNew;
    return {
      batch: { _id: String(jb._id), code: jb.code, roster_count: rosterCount, target_size: jb.target_size ?? null },
      will_create: toInsert.length, will_add_new: willAddNew, roster_after: rosterAfter,
      target_warning: jb.target_size && rosterAfter > jb.target_size
        ? `Roster would be ${rosterAfter} of target ${jb.target_size} — enrolment will be capped at ${jb.target_size}.` : null,
      holders: holderRows.map((h) => ({
        row: h.row, label: h.label, matched_on: h.matched_on, value: h.value,
        // out of scope: the holder is described by NOTHING that identifies them (no id, name, phone, link)
        holder_id: h.inScope ? h.holderId : null,
        candidate: h.inScope ? { _id: h.holderId, name: h.holder.name, phone: h.holder.phone ?? null } : null,
        link: h.inScope ? `/candidates?q=${encodeURIComponent(String(h.holder.name ?? ""))}` : null,
        can_assign: !h.refusal, refusal: h.refusal, warning: h.warning ?? null,
      })),
      ambiguous: ambiguousRows, new_refused: newRefused, new_warnings: newWarnings,
    };
  };

  if (!confirm) {
    return NextResponse.json({
      preview: toInsert.slice(0, 10), valid: toInsert.length,
      skipped: rows.length - candidates.length,
      template_rows_skipped: templateRows.slice(0, 10), template_rows_skipped_count: templateRows.length,
      duplicates: duplicates.slice(0, 25), duplicate_count: duplicates.length,
      education_unmatched: [...new Set(eduUnmatched)].slice(0, 25),
      // -154 (QA-426): a mapped destination nothing wrote. Surfaced on the PREVIEW so it is seen
      // before the import runs, not discovered later by a count that reads wrong.
      unhandled_fields: [...new Set(unhandledFields)],
      // per mapped column, how many rows had nothing in it - so a column mapped to the wrong
      // header shows up here as "all of them" instead of importing silently.
      blank_by_field: blankByField,
      row_count: rows.length,
      sidh_status_unmatched: [...new Set(sidhStatusUnmatched)].slice(0, 25),
      // QA-1191: on the PREVIEW, because the preview answering 200 while the confirm died with 400
      // was the cruellest half of this defect - the one screen built to report unreadable values was
      // the one screen that said nothing.
      // QA-1235 (checker, cycle 1): and cycle 1 shipped this key into a response NO SCREEN RENDERED,
      // which is the same defect one layer up - the checker drove a real browser and watched the
      // drawer print the education warning and stay silent about this one. The import drawer in
      // candidates/page.tsx now renders it beside education_unmatched. A field a route reports and a
      // screen ignores is not a report.
      batch_interest_unmatched: [...new Set(batchInterestUnmatched)].slice(0, 25),
      interest_unmatched: [...new Set(interestUnmatched)].slice(0, 25),
      date_unparseable: dateUnparseable.slice(0, 25), date_unparseable_count: dateUnparseable.length,
      phone_invalid: phoneInvalid.slice(0, 25), phone_invalid_count: phoneInvalid.length,
      // QA-727: on the PREVIEW, so a sheet whose Candidate ID column is mapped to the wrong header
      // is seen BEFORE the import runs — the same reasoning as unhandled_fields above it.
      candidate_id_invalid: candidateIdInvalid.slice(0, 25), candidate_id_invalid_count: candidateIdInvalid.length,
      // QA-941: on the PREVIEW too — the point of the preview is that a mis-mapped column is seen
      // BEFORE 45 rows land, and Aadhaar reaches a government export.
      aadhaar_invalid: aadhaarInvalid.slice(0, 25), aadhaar_invalid_count: aadhaarInvalid.length,
      // QA-902: the APAAR ID gets the same treatment on the PREVIEW. The duplicate list is not
      // cosmetic - a repeated APAAR makes the insert below fail as a whole batch, so this is the
      // one place it can be fixed before 45 good rows are lost with it.
      apaar_invalid: apaarInvalid.slice(0, 25), apaar_invalid_count: apaarInvalid.length,
      apaar_duplicate: apaarDuplicate.slice(0, 25), apaar_duplicate_count: apaarDuplicate.length,
      apaar_same_as_aadhaar: apaarSameAsAadhaar.slice(0, 25), apaar_same_as_aadhaar_count: apaarSameAsAadhaar.length,
      // QA-991: an APAAR/portal ID this sheet carries but a DIFFERENT, EXISTING candidate already
      // holds. The field is dropped from that row on confirm (never the row) rather than crashing
      // the whole batch on the database's own unique index - said here so it is seen before that.
      apaar_taken: apaarTaken.slice(0, 25), apaar_taken_count: apaarTaken.length,
      sidh_taken: sidhTaken.slice(0, 25), sidh_taken_count: sidhTaken.length,
      unknown_columns: unknownCols,
      // QA-110: say the quiet part — which columns are about to be DROPPED vs stored.
      ignored_columns: acceptUnknown ? [] : unknownCols,
      extra_columns_stored: acceptUnknown ? unknownCols : [],
      // qa-import-into-batch: present ONLY when a batch was chosen, so the no-batch response keeps exactly
      // its old key set.
      ...(joinBatch ? { batch_plan: batchPlan() } : {}),
    });
  }
  const importNote = (n: number) => `${n} imported, ${duplicates.length} flagged as possible duplicates${dateUnparseable.length ? `, ${dateUnparseable.length} unreadable dates` : ""}${phoneInvalid.length ? `, ${phoneInvalid.length} un-normalizable phones` : ""}${candidateIdInvalid.length ? `, ${candidateIdInvalid.length} portal Candidate ID(s) the gate cannot read` : ""}${apaarInvalid.length ? `, ${apaarInvalid.length} unreadable APAAR ID(s)` : ""}${aadhaarInvalid.length ? `, ${aadhaarInvalid.length} unreadable Aadhaar number(s)` : ""}${!acceptUnknown && unknownCols.length ? `, ${unknownCols.length} column(s) ignored: ${unknownCols.join(", ")}` : ""}`;
  // QA-896: the ids, so the screen can offer to put exactly these students on the batch the
  // operator came from. Without them the offer would have to guess "the newest N", which is wrong
  // the moment two people import at once.
  const commitBody = (imported: number, ids: string[]) => ({ imported, imported_ids: ids, skipped: rows.length - candidates.length, duplicate_count: duplicates.length, date_unparseable: dateUnparseable.slice(0, 25), date_unparseable_count: dateUnparseable.length, phone_invalid: phoneInvalid.slice(0, 25), phone_invalid_count: phoneInvalid.length, candidate_id_invalid: candidateIdInvalid.slice(0, 25), candidate_id_invalid_count: candidateIdInvalid.length, aadhaar_invalid: aadhaarInvalid.slice(0, 25), aadhaar_invalid_count: aadhaarInvalid.length, apaar_invalid: apaarInvalid.slice(0, 25), apaar_invalid_count: apaarInvalid.length, apaar_duplicate: apaarDuplicate.slice(0, 25), apaar_duplicate_count: apaarDuplicate.length, apaar_same_as_aadhaar: apaarSameAsAadhaar.slice(0, 25), apaar_same_as_aadhaar_count: apaarSameAsAadhaar.length, apaar_taken: apaarTaken.slice(0, 25), apaar_taken_count: apaarTaken.length, sidh_taken: sidhTaken.slice(0, 25), sidh_taken_count: sidhTaken.length, ignored_columns: acceptUnknown ? [] : unknownCols, unhandled_fields: [...new Set(unhandledFields)], sidh_status_unmatched: [...new Set(sidhStatusUnmatched)].slice(0, 25), batch_interest_unmatched: [...new Set(batchInterestUnmatched)].slice(0, 25), blank_by_field: blankByField });

  if (!joinBatch || !joinDefaults) {
    const docs = await Candidate.insertMany(candidates);
    await audit({ entity: "Candidate", entityId: docs[0]?._id ?? location, field: "import", newValue: importNote(docs.length), actor: user.id });
    return NextResponse.json(commitBody(docs.length, docs.map((d) => String(d._id))), { status: 201 });
  }

  // ---------------- batch mode: import, then add to the batch, and report what REALLY happened ----------------
  const jb = joinBatch;
  // the ticks are read BEFORE anything is written, so a malformed field refuses with zero writes
  let ticksRaw: unknown = [];
  const rawTicks = form.get("assign_holders");
  if (rawTicks !== null && String(rawTicks) !== "") {
    try { ticksRaw = JSON.parse(String(rawTicks)); } catch { throw new HttpError(400, "assign_holders must be a JSON list of candidate ids"); }
  }
  if (!Array.isArray(ticksRaw)) throw new HttpError(400, "assign_holders must be a JSON list of candidate ids");
  // D3: a tick counts only if it names a holder THIS sheet resolved to - a forged or stale id is ignored
  const ticked = new Set((ticksRaw as unknown[]).map(String).filter((id) => holderRows.some((h) => h.holderId === id)));

  // ids are assigned here (not by the driver) so that after a failed insert the rows that DID land can be
  // read back by id and counted truthfully
  const newIds = toInsert.map((c) => { const id = new Types.ObjectId(); (c as any)._id = id; return id; });
  let landed: Record<string, unknown>[] = toInsert;
  let insertFailure: { status: number; message: string } | null = null;
  try {
    await Candidate.insertMany(toInsert);
  } catch (e) {
    insertFailure = translateError(e);
    const got = await Candidate.find({ _id: { $in: newIds } }).select("_id").lean<any[]>();
    const gotSet = new Set(got.map((g) => String(g._id)));
    landed = toInsert.filter((c) => gotSet.has(String((c as any)._id)));
  }

  const result = {
    batch: { _id: String(jb._id), code: jb.code },
    created: landed.length, assigned_new: 0, assigned_existing: 0,
    holders_skipped: [] as { row: number; label: string; value: string; matched_on: string; reason: string }[],
    refused: [] as { row: number; label: string; stage: "new" | "holder" | "row"; reason: string }[],
    created_not_assigned: [] as string[],
    warnings: [] as string[],
  };
  const finish = async () => {
    await audit({ entity: "Candidate", entityId: landed[0] ? (landed[0] as any)._id : location, field: "import", newValue: `${importNote(landed.length)}; added to batch ${jb.code}: ${result.assigned_new} new + ${result.assigned_existing} existing`, actor: user.id });
    await audit({ entity: "Batch", entityId: jb._id, field: "import_assign", newValue: `${result.created} created, ${result.assigned_new} new + ${result.assigned_existing} existing added, ${result.holders_skipped.length} existing skipped, ${result.refused.length} refused`, actor: user.id });
  };
  if (insertFailure) {
    // nothing is assigned after a failed insert: the operator fixes the sheet and runs it again.
    // The rows that DID land are listed as created-but-not-added, so created = assigned_new + created_not_assigned.length
    // holds on this path too (review fold-in 2026-10-17).
    for (const c of landed) result.created_not_assigned.push(String((c as any)._id));
    await finish();
    return NextResponse.json({ error: `${insertFailure.message} ${result.created} of ${toInsert.length} new candidate(s) were created before the write stopped; none were added to the batch.`, batch_result: result }, { status: insertFailure.status });
  }

  for (const c of landed) {
    const rowNo = rowNoOf.get(c) ?? 0;
    try {
      const joined = await assignCandidateToBatch({ batch: jb, candidate: c as any, actorId: user.id, defaults: joinDefaults });
      result.assigned_new++;
      for (const w of [joined.rosterWarning, joined.eligibilityWarning]) if (w) result.warnings.push(w);
    } catch (e) {
      result.refused.push({ row: rowNo, label: personLabel(c), stage: "new", reason: translateError(e).message });
      result.created_not_assigned.push(String((c as any)._id));
    }
  }
  for (const a of ambiguousRows) result.refused.push({ row: a.row, label: a.label, stage: "row", reason: a.reason });
  for (const h of holderRows) {
    const skip = (reason: string) => result.holders_skipped.push({ row: h.row, label: h.label, value: h.value, matched_on: h.matched_on, reason });
    if (!ticked.has(h.holderId) || h.dupOfRow || !h.inScope) { skip(h.inScope ? (h.dupOfRow ? h.refusal! : "Not ticked - left as it is.") : "Belongs to a candidate outside your centres - left as it is."); continue; }
    if (h.refusal) { result.refused.push({ row: h.row, label: h.label, stage: "holder", reason: h.refusal }); continue; }
    try {
      const joined = await assignCandidateToBatch({ batch: jb, candidate: h.holder, actorId: user.id, defaults: joinDefaults });
      result.assigned_existing++;
      for (const w of [joined.rosterWarning, joined.eligibilityWarning]) if (w) result.warnings.push(w);
    } catch (e) {
      result.refused.push({ row: h.row, label: h.label, stage: "holder", reason: translateError(e).message });
    }
  }
  await finish();
  return NextResponse.json({ ...commitBody(landed.length, landed.map((c) => String((c as any)._id))), batch_result: result }, { status: 201 });
});
