// Per-entity field catalog for the tab-mapping wizard (2026-08-13).
//
// Why this exists: sheet ingestion used to live in a hand-written script (scripts/
// seed-avpl-master.mjs) that only an operator could extend. The production server has no such
// operator — so the columns a tab maps to must be proposable, editable and approvable in the UI,
// and every transform the script knew (phones, spoken dates, fuzzy centre names) has to live
// here, server-side. Trainer pay fields are deliberately absent (they are masked on read for
// non-trainers.manage; a mapping surface must not become the unmasked path). Trainer
// pipeline_status is also absent — stages move only through the guarded transition route.

export type FieldType = "text" | "phone" | "date" | "dob" | "number" | "list" | "enum" | "fk_location" | "fk_program";

export type FieldSpec = {
  key: string;
  label: string;
  type: FieldType;
  aliases: string[]; // normalized header names that suggest this field
  enum?: readonly string[];
  required?: boolean; // must be covered (column or constant) before a mapping can be approved
  keyable?: boolean; // usable as the row-identity field
};

const S = (v: unknown) => String(v ?? "").trim();
export const normHeader = (v: unknown) => S(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const phone10 = (v: unknown) => { const d = S(v).replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };

// "6th July" / "12 Aug" — the team writes dates as spoken; the project year is the current one.
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function parseSheetDate(text: unknown): Date | null {
  const raw = S(text);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO first — unambiguous
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  const dmy = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/); // Indian sheets write d/m/y
  if (dmy) {
    const y = +dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3];
    return new Date(Date.UTC(y, +dmy[2] - 1, +dmy[1]));
  }
  const t = normHeader(raw);
  const day = (t.match(/\b(\d{1,2})(st|nd|rd|th)?\b/) ?? [])[1];
  const mon = Object.keys(MONTHS).find((m) => t.includes(m));
  if (!day || mon == null) return null;
  return new Date(Date.UTC(new Date().getUTCFullYear(), MONTHS[mon], Number(day)));
}

// The team spells places by ear (Kaushambhi/Kausambi) — drop vowels and doubled letters before
// comparing, so a spelling never costs us the row. Same ladder as the seed script: district
// exact → name contains → word overlap → devoweled.
export const soundish = (v: unknown) => normHeader(v).replace(/[aeiou]/g, "").replace(/(.)\1+/g, "$1");
export type LocationLite = { _id: unknown; name?: string; district?: string; city?: string };
export type ProgramLite = { _id: unknown; name?: string; code?: string; trainer_skill?: string };

export function resolveLocation(raw: unknown, locations: LocationLite[]): LocationLite | null {
  const v = normHeader(raw).replace(/\b(up|haryana|uttar pradesh)\b/g, "").trim();
  if (!v) return null;
  const sv = soundish(v);
  return locations.find((l) => normHeader(l.district) === v)
    ?? locations.find((l) => normHeader(l.name).includes(v) || (l.district && v.includes(normHeader(l.district))))
    ?? locations.find((l) => v.split(" ").some((w) => w.length > 4 && normHeader(l.name).includes(w)))
    ?? locations.find((l) => !!sv && (soundish(l.district) === sv || soundish(l.name).includes(sv)))
    ?? null;
}

// "DST" / "SPIT" — the codes the team writes in the sheet for job roles.
const SKILL_TO_ROLE: Record<string, string> = {
  dst: "Drone Service Technician", spit: "Solar Panel Installation Technician",
  bsrt: "Battery System Repair Technician", dswt: "Drone Software Technician",
};
export function resolveProgram(raw: unknown, programs: ProgramLite[]): ProgramLite | null {
  const n = normHeader(raw);
  if (!n) return null;
  const role = normHeader(SKILL_TO_ROLE[n] ?? S(raw));
  return programs.find((p) => normHeader(p.name) === role || normHeader(p.trainer_skill) === role || normHeader(p.code) === n)
    // -151 (QA-349, found by the checker's control-character sweep): this read
    // `normHeader(p.code ?? "<NUL>")` - a literal NUL byte, the fourth instance this session of a
    // backslash escape written into a file as the raw control character it names, and the first in
    // product code. Two things follow. normHeader strips it, so the `??` guard was provably
    // equivalent to `?? ""` - and `role.includes("")` is ALWAYS TRUE, so a programme with no code
    // would match EVERY role and win this fuzzy pass. Latent only because Program.code is required.
    // And the byte made the file BINARY to git grep and ripgrep, so the thing that made it inert is
    // the same thing that hid it. An absent code must match nothing, which is what this now says.
    ?? programs.find((p) => normHeader(p.name).includes(role)
      || (!!normHeader(p.code) && role.includes(normHeader(p.code))))
    ?? null;
}

// Free-text qualifications → our education enum (the candidate sheets write "B.A", "12th", …).
export function coerceEducation(raw: unknown): string | null {
  const t = normHeader(raw);
  if (!t) return null;
  if (/post ?grad|\bpg\b|\bm ?a\b|\bm ?sc\b|\bm ?com\b|mba|m ?tech/.test(t)) return "Post Graduate";
  if (/grad|\bb ?a\b|\bb ?sc\b|\bb ?com\b|b ?tech|bca|diploma/.test(t)) return "Graduate";
  if (/12|inter|senior secondary|\bxii\b/.test(t)) return "12th Pass";
  if (/10|matric|high school|\bx\b/.test(t)) return "10th Pass";
  if (/below|\b[89]th\b|middle|primary/.test(t)) return "Below 10th";
  return null;
}

export const FIELD_CATALOG: Record<"Candidate" | "Trainer" | "Location", FieldSpec[]> = {
  Candidate: [
    { key: "name", label: "Name", type: "text", required: true, aliases: ["name", "candidate name", "student name", "full name"] },
    { key: "phone", label: "Phone", type: "phone", required: true, keyable: true, aliases: ["phone", "mobile", "mobile number", "phone number", "contact", "contact number", "whatsapp number"] },
    { key: "alt_phone", label: "Alternate phone", type: "phone", aliases: ["alt phone", "alternate number", "alternate phone", "alternate mobile"] },
    { key: "gender", label: "Gender", type: "enum", enum: ["Female", "Male", "Other"], aliases: ["gender", "sex"] },
    // Accepts a date OR a bare age ("22") — the client's registration tabs ask "What is your age?".
    { key: "dob", label: "Date of birth / age", type: "dob", aliases: ["dob", "date of birth", "age", "what is your age"] },
    { key: "education", label: "Education", type: "enum", enum: ["Below 10th", "10th Pass", "12th Pass", "Graduate", "Post Graduate"], aliases: ["education", "qualification", "educational qualification", "highest qualification"] },
    { key: "source", label: "Source", type: "text", aliases: ["source", "mobiliser", "campaign", "reference"] },
    { key: "sidh_status", label: "SIDH status", type: "enum", enum: ["Not Registered", "Link Sent", "Registered", "Registration Failed"], aliases: ["sidh status", "enrolled status", "enrollment status", "registration status"] },
    { key: "sidh_candidate_id", label: "Portal candidate ID (SIDH/NCVET)", type: "text", aliases: ["candidate id", "portal candidate id", "can id", "sidh id"] },
    // QA-902 (2026-08-24): the government APAAR ID. Listed HERE - directly under the portal id and
    // ABOVE both aadhaar_no and id_reference - for the reason the Aadhaar row records below: the
    // nearest-looking option wins when the right one is not offered, and that is precisely how
    // QA-414 put 55 portal ids into id_reference. "apaar id" also beats "candidate id" on a header
    // like "Candidate APAAR ID", because the resolver takes the LONGEST matching alias first.
    { key: "apaar_id", label: "APAAR ID (govt academic account, 12 digits)", type: "text", aliases: ["apaar", "apaar id", "apaar no", "apaar number", "apar id", "abc id", "academic bank of credits", "academic bank of credits id"] },
    // -154 (QA-424): these five have been accepted by the Excel import since it was written and
    // were never in the catalog, so the catalog and the import screen each held half the truth.
    // They are all real fields on CandidateSchema.
    { key: "email", label: "Email", type: "text", aliases: ["email", "email id", "mail", "e mail"] },
    // The label carries the warning because the ambiguity is the whole defect: QA-414 measured 55
    // live candidates whose PORTAL id landed here, because this was the closest-looking option on
    // a screen that did not offer the right one.
    // 2026-08-24: the Aadhaar number is a real column now, so it gets a real destination. Listed
    // ABOVE id_reference deliberately - the alias "aadhaar reference" below used to be the closest
    // match a sheet's Aadhaar column could find, which is precisely how QA-414 put 55 portal ids into
    // id_reference: the nearest-looking option wins when the right one is not offered.
    { key: "aadhaar_no", label: "Aadhaar number", type: "text", aliases: ["aadhaar", "aadhar", "adhaar", "adhar", "aadhaar number", "aadhar number", "aadhaar no", "uid", "uid number"] },
    // QA-945: sheets from mobilisers carry an availability column often enough to be worth mapping.
    { key: "batch_interest", label: "Interested in (Current / Future batch)", type: "enum", enum: ["Current", "Future"], aliases: ["batch interest", "interested in", "availability", "current or future", "future batch"] },
    { key: "id_reference", label: "Govt ID reference (NOT Aadhaar, NOT the portal candidate ID)", type: "text", aliases: ["id reference", "govt id", "government id", "id proof"] },
    { key: "last_training_date", label: "Last training date", type: "date", aliases: ["last training date", "last training", "previous training date"] },
    { key: "interested_programs", label: "Interested programmes (comma-separated)", type: "list", aliases: ["interested programs", "interested programmes", "preferred course", "course interested"] },
    { key: "interested_locations", label: "Interested centres (comma-separated)", type: "list", aliases: ["interested locations", "interested centres", "preferred centre", "preferred location"] },
    { key: "location", label: "Location (centre)", type: "fk_location", required: true, aliases: ["location", "interested location", "centre", "center", "institution", "district"] },
    { key: "program", label: "Program (job role)", type: "fk_program", required: true, aliases: ["program", "job role", "course", "trade", "skill"] },
  ],
  Trainer: [
    { key: "name", label: "Name", type: "text", required: true, aliases: ["name", "trainer name", "full name"] },
    { key: "phone", label: "Phone", type: "phone", required: true, keyable: true, aliases: ["phone", "mobile", "mobile number", "phone number", "contact", "contact number"] },
    { key: "email", label: "Email", type: "text", aliases: ["email", "email id", "mail"] },
    { key: "qualification", label: "Qualification", type: "text", aliases: ["qualification", "education", "education attained", "highest qualification"] },
    { key: "skills", label: "Skills", type: "list", aliases: ["skill", "skills", "trade", "specialization"] },
    { key: "tr_id", label: "TR ID (SIP)", type: "text", aliases: ["tr id", "sip id", "trainer sip id", "trid"] },
    { key: "industry_experience_years", label: "Industry experience (years)", type: "number", aliases: ["industry experience", "experience years", "total experience", "experience"] },
    { key: "teaching_experience_years", label: "Teaching experience (years)", type: "number", aliases: ["teaching experience", "training experience"] },
    { key: "pipeline_note", label: "Note", type: "text", aliases: ["note", "notes", "remark", "remarks", "comments", "status note", "response"] },
    { key: "source", label: "Source", type: "text", aliases: ["source", "reference", "referred by"] },
    { key: "home_location", label: "Home location", type: "fk_location", aliases: ["location", "home location", "base location", "city", "nominated location"] },
  ],
  Location: [
    // Locations are never auto-created by a mapping (centres are contract entities) — only
    // updated. external_id/name identify the row.
    { key: "external_id", label: "External ID (TC ID)", type: "text", keyable: true, aliases: ["tc id", "external id", "center id", "centre id", "institution id"] },
    { key: "name", label: "Institution name", type: "text", keyable: true, aliases: ["institution name", "centre name", "center name", "name", "institution"] },
    { key: "city", label: "City", type: "text", aliases: ["city", "town"] },
    { key: "district", label: "District", type: "text", aliases: ["district"] },
    { key: "state", label: "State", type: "text", aliases: ["state"] },
    { key: "address", label: "Address", type: "text", aliases: ["address", "full address"] },
    { key: "spoc_name", label: "SPOC name", type: "text", aliases: ["spoc name", "spoc"] },
    { key: "spoc_phone", label: "SPOC phone", type: "phone", aliases: ["spoc phone", "spoc mobile", "spoc contact"] },
    { key: "principal_name", label: "Principal name", type: "text", aliases: ["principal name", "principal"] },
    { key: "principal_phone", label: "Principal phone", type: "phone", aliases: ["principal phone", "principal mobile"] },
    { key: "tc_id", label: "TC ID (portal)", type: "text", aliases: ["tc id"] },
    { key: "tc_status", label: "TC status", type: "text", aliases: ["tc status"] },
    { key: "tc_password", label: "TC password", type: "text", aliases: ["tc password", "password"] },
    { key: "operating_partner", label: "Operating partner", type: "text", aliases: ["operating partner", "partner"] },
    { key: "cluster_head_name", label: "Cluster head", type: "text", aliases: ["cluster head", "cluster head name"] },
    { key: "cluster_head_phone", label: "Cluster head phone", type: "phone", aliases: ["cluster head phone", "cluster head mobile"] },
  ],
};

export type CatalogEntity = keyof typeof FIELD_CATALOG;

/**
 * -154 (QA-414 S1 / QA-424, REQ-380 + REQ-385): the destinations the CANDIDATE EXCEL IMPORT offers
 * per column - and the ONE list both the mapping screen and the import writer read.
 *
 * Before this there were FIVE hand-maintained copies of "the fields a candidate has": this catalog,
 * the mapping dropdown (candidates/page.tsx), the import writer (candidates/import/route.ts), and
 * the two drawer routes. The dropdown and the catalog had drifted in BOTH directions, and the cost
 * was measured: the dropdown never offered sidh_candidate_id, so 55 live candidates hold their
 * portal ID in id_reference - the nearest-looking option the screen did offer - while the field the
 * government attendance matcher and the certificate matcher actually read sits empty.
 *
 * WHY location AND program ARE EXCLUDED, which is not an oversight: on this screen they are chosen
 * ONCE FOR THE WHOLE FILE (importState.location / importState.program, posted as form fields and
 * applied to every row), so offering them per column would invite a second, conflicting answer to a
 * question already asked. The sheet-sync path DOES map them per column and reads FIELD_CATALOG
 * directly - which is why this narrowing lives here, named, rather than inside the catalog itself.
 */
export const CANDIDATE_IMPORT_FIELDS: FieldSpec[] = FIELD_CATALOG.Candidate
  .filter((f) => f.type !== "fk_location" && f.type !== "fk_program");

export function fieldSpec(entity: CatalogEntity, key: string): FieldSpec | undefined {
  return FIELD_CATALOG[entity].find((f) => f.key === key);
}

// Longest-alias-first suggestion (the govt-attendance resolver pattern): each header gets the
// catalog field whose alias it equals or starts with; a field is claimed at most once.
export function suggestMapping(headers: string[], entity: CatalogEntity): { header: string; field: string | null }[] {
  const specs = FIELD_CATALOG[entity];
  const claimed = new Set<string>();
  // (alias, field) pairs, longest alias first so "mobile number" wins over "mobile".
  const pairs = specs.flatMap((s) => s.aliases.map((a) => ({ alias: a, field: s.key })))
    .sort((a, b) => b.alias.length - a.alias.length);
  return headers.map((h) => {
    const n = normHeader(h);
    if (!n) return { header: h, field: null };
    const hit = pairs.find((p) => !claimed.has(p.field) && (n === p.alias || n.startsWith(p.alias + " ") || n.endsWith(" " + p.alias)));
    if (!hit) return { header: h, field: null };
    claimed.add(hit.field);
    return { header: h, field: hit.field };
  });
}
