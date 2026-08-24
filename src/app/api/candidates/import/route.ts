import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate, EDUCATION_LEVEL, Location, Program, SIDH_STATUS } from "@/models";
import { parseSheetDate } from "@/lib/rules";
import { CANDIDATE_IMPORT_FIELDS } from "@/lib/field-catalog";
import { audit } from "@/lib/audit";
import { findDuplicateCandidates, normalizePhone } from "@/lib/duplicates";
import { canonicalAadhaar, canonicalApaar, canonicalPhone, sameGovtNumber } from "@/lib/validate";
import { personLabel } from "@/lib/person";
import { looksLikeCan, normalizeCan } from "@/lib/govt-attendance";

// -154 (QA-424, REQ-385): the SET of importable fields comes from the catalog; the HANDLING stays
// deliberate. Deriving behaviour from a type would have quietly changed how existing fields are
// coerced (gender is "enum" in the catalog and has always been written as free text here), so the
// two are kept apart: the catalog decides WHAT may be mapped, these sets decide HOW, and any field
// the catalog offers that no branch handles is REPORTED rather than dropped (QA-426).
const TEXT_IMPORT_FIELDS = new Set(
  CANDIDATE_IMPORT_FIELDS.filter((f) => f.type === "text" || f.type === "phone" || f.type === "enum")
    .map((f) => f.key)
    .filter((k) => k !== "education" && k !== "sidh_status"), // these two are coerced against their enum below
);
const HANDLED_IMPORT_FIELDS = new Set<string>([
  ...TEXT_IMPORT_FIELDS,
  "dob", "last_training_date",          // parsed by parseSheetDate
  "education", "sidh_status",           // coerced against their enum
  "interested_programs", "interested_locations", // resolved by name
]);

// Excel import: upload → map → preview → confirm (screen spec).
// POST multipart: file, location, program, mapping (JSON {excelCol: name|phone|alt_phone|gender|source}), confirm ("1" to write)
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.manage"); // togglable (2026-08-11)
  const form = await req.formData();
  const file = form.get("file") as File | null;
  const location = String(form.get("location") || "");
  const program = String(form.get("program") || "");
  const confirm = form.get("confirm") === "1";
  const mappingRaw = form.get("mapping");
  if (!file) throw new HttpError(400, "file is required");
  if (!location || !program) throw new HttpError(400, "location and program are required");
  assertLocationInScope(user, location);

  const buf = Buffer.from(await file.arrayBuffer());
  const wb = XLSX.read(buf, { type: "buffer" });
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
  const mapped = rows
    .map((r, rowIdx) => {
      const c: Record<string, unknown> = { location, program, lifecycle_status: "Unassigned", created_by: user.id };
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
          else blankByField[field] = (blankByField[field] ?? 0) + 1;
        }
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
  const aadhaarInvalid = [];
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
  for (const c of candidates.slice(0, 300)) { // bounded: preview only, not a full-file scan
    const hits = await findDuplicateCandidates({ name: String(c.name), phone: String(c.phone), dob: c.dob as Date });
    if (hits.length) existingHits.push(`${personLabel(c)} → already exists: ${hits[0].message}`);
  }
  const duplicates = [...inFile, ...existingHits];

  if (!confirm) {
    return NextResponse.json({
      preview: candidates.slice(0, 10), valid: candidates.length,
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
      unknown_columns: unknownCols,
      // QA-110: say the quiet part — which columns are about to be DROPPED vs stored.
      ignored_columns: acceptUnknown ? [] : unknownCols,
      extra_columns_stored: acceptUnknown ? unknownCols : [],
    });
  }
  const docs = await Candidate.insertMany(candidates);
  await audit({ entity: "Candidate", entityId: docs[0]?._id ?? location, field: "import", newValue: `${docs.length} imported, ${duplicates.length} flagged as possible duplicates${dateUnparseable.length ? `, ${dateUnparseable.length} unreadable dates` : ""}${phoneInvalid.length ? `, ${phoneInvalid.length} un-normalizable phones` : ""}${candidateIdInvalid.length ? `, ${candidateIdInvalid.length} portal Candidate ID(s) the gate cannot read` : ""}${apaarInvalid.length ? `, ${apaarInvalid.length} unreadable APAAR ID(s)` : ""}${aadhaarInvalid.length ? `, ${aadhaarInvalid.length} unreadable Aadhaar number(s)` : ""}${!acceptUnknown && unknownCols.length ? `, ${unknownCols.length} column(s) ignored: ${unknownCols.join(", ")}` : ""}`, actor: user.id });
  return NextResponse.json({ imported: docs.length, skipped: rows.length - candidates.length, duplicate_count: duplicates.length, date_unparseable: dateUnparseable.slice(0, 25), date_unparseable_count: dateUnparseable.length, phone_invalid: phoneInvalid.slice(0, 25), phone_invalid_count: phoneInvalid.length, candidate_id_invalid: candidateIdInvalid.slice(0, 25), candidate_id_invalid_count: candidateIdInvalid.length, aadhaar_invalid: aadhaarInvalid.slice(0, 25), aadhaar_invalid_count: aadhaarInvalid.length, apaar_invalid: apaarInvalid.slice(0, 25), apaar_invalid_count: apaarInvalid.length, apaar_duplicate: apaarDuplicate.slice(0, 25), apaar_duplicate_count: apaarDuplicate.length, apaar_same_as_aadhaar: apaarSameAsAadhaar.slice(0, 25), apaar_same_as_aadhaar_count: apaarSameAsAadhaar.length, ignored_columns: acceptUnknown ? [] : unknownCols, unhandled_fields: [...new Set(unhandledFields)], sidh_status_unmatched: [...new Set(sidhStatusUnmatched)].slice(0, 25), blank_by_field: blankByField }, { status: 201 });
});
