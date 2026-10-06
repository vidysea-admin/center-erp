// R8 (QA-2845, Manish 2026-10-06: "yahan pe ek download ka option ho ... naam, number, phone, email";
// Umesh: "it should be custom like jo jo column us table mai selected ho vo download ho jaayee").
//
// THE ONE LIST of candidate-table columns. The Candidates screen (candidates/page.tsx) and the Excel
// door (api/candidates/export/route.ts) both read THIS module - ARCHITECTURE.md section 1.4 ("each
// screen and its export MUST read the same function") applied to a column list. An export that keeps
// its own list is an export that eventually offers a column the screen does not, or the other way
// round, and then nobody can say which one is the table.
//
// CLIENT-SAFE: no server imports. The page needs the keys, labels and default visibility; the route
// needs the same keys and the text each one prints. The enriched row shape is what GET
// /api/candidates returns (populated location/program, `active_batch`, `eligibility`,
// `latest_result`) - the route builds the same shape with `enrichCandidateRows` (rules.ts), the one
// function the list API's mapItems also calls.
import { freshJourneyOf, isFreshCandidate, journeyOf } from "@/lib/candidate-journey";

export type CandidateColumn = {
  key: string;
  label: string;
  /** false = an optional column: offered in the table's Columns picker, hidden until someone ticks it. */
  defaultVisible: boolean;
  /** What the cell prints, as plain text - what the Excel file carries. */
  value: (r: any) => string;
};

const text = (v: unknown): string => (v == null ? "" : String(v));
// Business dates are stored at UTC midnight (ARCHITECTURE.md landmine 12) - slice the ISO date, never
// toLocale*, so the file says the same calendar day the record does whatever zone the server runs in.
const dateText = (v: unknown): string => {
  if (!v) return "";
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};
const progOf = (r: any) => r.program ?? r.active_batch?.program ?? null;

// The same words the Eligible column filters on (candidates/page.tsx used to spell this inline).
export function eligibilityTextOf(r: any): string {
  if (!r.eligibility) return "";
  if (!r.eligibility.eligible) return "Not eligible";
  return r.eligibility.unknown?.length ? "Unverified" : "Eligible";
}

// The journey/stage a row shows. The screen picks per BUCKET; a row is in the Fresh bucket exactly
// when isFreshCandidate says so, so the export can derive the same answer per row.
export function stageTextOf(r: any): string {
  return isFreshCandidate(r) ? freshJourneyOf(r) : journeyOf({ ...r, active_batch_status: r.active_batch?.status });
}

// ORDER IS THE TABLE'S ORDER. The first nine are the columns the table has always had (default
// visible); the rest are the optional ones R8 adds, hidden by default.
//
// NO GOVERNMENT NUMBER IS EVER IN HERE - not Aadhaar, not APAAR (ARCHITECTURE.md section 3.2: both are
// deliberately absent from every table column and from searchFields/audit masking decisions, and an
// Excel file leaves the building in a way a screen does not). `id_reference` is a different thing but
// is also left out: nobody asked for it, and a column nobody asked for is a column to refuse.
export const CANDIDATE_COLUMNS: CandidateColumn[] = [
  { key: "name", label: "Name", defaultVisible: true, value: (r) => text(r.name) },
  { key: "phone", label: "Phone", defaultVisible: true, value: (r) => text(r.phone) },
  { key: "location", label: "Location", defaultVisible: true, value: (r) => text(r.location?.name) },
  { key: "batch", label: "Batch", defaultVisible: true, value: (r) => text(r.active_batch?.code) },
  { key: "program", label: "Program", defaultVisible: true, value: (r) => text(progOf(r)?.name) },
  { key: "lifecycle_status", label: "Stage / Journey status", defaultVisible: true, value: stageTextOf },
  { key: "eligibility", label: "Eligible", defaultVisible: true, value: eligibilityTextOf },
  { key: "sidh_status", label: "SIDH", defaultVisible: true, value: (r) => text(r.sidh_status ?? "Not Registered") },
  { key: "source", label: "Source", defaultVisible: true, value: (r) => text(r.source ?? "Entered in ERP") },
  // ---- optional, default hidden (R8) ----
  { key: "email", label: "Email", defaultVisible: false, value: (r) => text(r.email) },
  { key: "alt_phone", label: "Alt phone", defaultVisible: false, value: (r) => text(r.alt_phone) },
  { key: "gender", label: "Gender", defaultVisible: false, value: (r) => text(r.gender) },
  { key: "dob", label: "Date of birth", defaultVisible: false, value: (r) => dateText(r.dob) },
  { key: "father_name", label: "Father's name", defaultVisible: false, value: (r) => text(r.father_name) },
  { key: "district", label: "District", defaultVisible: false, value: (r) => text(r.district) },
  { key: "education", label: "Education", defaultVisible: false, value: (r) => text(r.education) },
  { key: "sidh_candidate_id", label: "SIDH candidate ID", defaultVisible: false, value: (r) => text(r.sidh_candidate_id) },
];

export const CANDIDATE_COLUMN_KEYS: string[] = CANDIDATE_COLUMNS.map((c) => c.key);
export const OPTIONAL_CANDIDATE_COLUMN_KEYS: string[] = CANDIDATE_COLUMNS.filter((c) => !c.defaultVisible).map((c) => c.key);

// Named so a refusal can SAY why, and so a pin has one list to hold against the one above. Being
// absent from CANDIDATE_COLUMNS is what actually keeps them out (the route is a whitelist); this list
// only changes the wording of the 400 and gives the e2e pin something to assert against.
export const CANDIDATE_EXPORT_FORBIDDEN: string[] = ["aadhaar_no", "apaar_id"];

export type ExportColsCheck = { ok: true; cols: CandidateColumn[] } | { ok: false; error: string };

// Validates a requested column list against the whitelist. Unknown or forbidden keys are REFUSED by
// name, never silently dropped: a file that quietly lacks a column someone asked for reads as a
// complete file, which is the worst way for an export to be wrong.
export function resolveExportCols(requested: unknown): ExportColsCheck {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, error: "Choose at least one column to download." };
  }
  const keys = requested.map((k) => String(k ?? "").trim());
  const seen = new Set<string>();
  const out: CandidateColumn[] = [];
  for (const k of keys) {
    if (CANDIDATE_EXPORT_FORBIDDEN.includes(k)) {
      return { ok: false, error: `The "${k}" column is never exported - government ID numbers do not leave the system in a file.` };
    }
    const def = CANDIDATE_COLUMNS.find((c) => c.key === k);
    if (!def) return { ok: false, error: `Unknown column "${k.slice(0, 40)}". Allowed columns: ${CANDIDATE_COLUMN_KEYS.join(", ")}.` };
    if (seen.has(k)) continue; // a repeated key is the same column once, not an error
    seen.add(k);
    out.push(def);
  }
  return { ok: true, cols: out };
}
