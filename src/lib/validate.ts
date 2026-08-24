// QA-141 (Umesh, 15/08, Arun-trainer episode: a 12-digit keyboard-mash phone sat on prod with
// nothing to stop it): format checks for the identity fields, shared CLIENT-SAFE so the form
// warns while typing and the API refuses with the same words — one rule, two callers, no
// drifting copy (slot-rules.ts precedent). Policy split, deliberately:
//   - MANUAL entry (forms/API) is STRICT — a human is right there to fix the field.
//   - BULK imports normalize when they can and REPORT what they could not, but never drop a
//     row over format ("restrict mat karo — data mil jaye", the custom_fields ruling).
// Phone canon: exactly 10 digits, stored bare. +91/0-prefixed forms normalize to the same 10
// so one person cannot become three rows under a raw-string unique index.
// NOT the same job as lib/duplicates.ts normalizePhone — that one is a deliberately LOOSE
// last-10 comparison key for duplicate-warning lookups and never refuses anything; this one
// is the strict write-time canonicalizer (null = refuse). Import the one you mean.

export function canonicalPhone(v: unknown): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
}

export function phoneError(v: unknown, opts?: { optional?: boolean }): string | null {
  const s = String(v ?? "").trim();
  if (!s) return opts?.optional ? null : "Phone is required.";
  return canonicalPhone(s) ? null : "Phone must be a 10-digit mobile number (+91/0 prefix is fine — it is stored as the bare 10 digits).";
}

// ---- Aadhaar (2026-08-24, Umesh: "candidate form mai aadhaar number nhi aa rha hai, aadhaar
// number k liye form mai daal") ----
//
// READ THIS BEFORE ASSUMING THE FIELD WAS SIMPLY FORGOTTEN. Until 2026-08-24 this product
// deliberately did NOT hold an Aadhaar number: `models/index.ts` USED TO label `id_reference`
// "government ID reference (NOT the Aadhaar number itself)", and `api/candidates/export-sidh` USED
// TO ship the `aadhaar_or_vid` column blank, commented "filled by the calling agent, never stored
// here". Both of those lines are gone — quoted here in the PAST TENSE on purpose, because this
// comment is the record of a reversal and a reader must not mistake the quotation for the code. Umesh reversed
// that decision explicitly, and chose the full number on all three intake doors. The comments that
// asserted the old rule are corrected in the same change, because a comment that outlives its rule
// is how the next reader gets it wrong (QA-606).
//
// Manual entry is STRICT, exactly like phone above: a human is at the keyboard and can fix it.
//
// QA-943 (qa-233 checker): this sentence used to continue "bulk import keeps the normalize-and-report
// lane" — and that lane DID NOT EXIST for this field when the sentence was written. A checksum failure
// and the literal "NOT-AN-AADHAAR" both imported silently. That is precisely QA-727, where an excuse
// named a safeguard that was not there, repeated one release later by the person who had cited it.
// The lane is real now (`aadhaar_invalid` in api/candidates/import), so the claim is true — but it is
// worth leaving the history here rather than a clean sentence, because the failure was not the missing
// code, it was asserting the code existed.
//
// The checksum is the point, not decoration. Aadhaar carries a Verhoeff check digit, which catches
// every single-digit error and every adjacent transposition - the two ways a hand-typed 12-digit
// number actually goes wrong. Without it a typo is stored, looks perfectly valid on screen, and is
// only discovered when the government portal rejects that student weeks later. Same posture as
// `looksLikeCan` for portal IDs (QA-714): refuse at the door, where somebody can still be told.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
function verhoeffOk(digits: string): boolean {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(rev[i])]];
  return c === 0;
}

/** 12 bare digits, or null. Spaces and hyphens are how people write it and are not an error. */
export function canonicalAadhaar(v: unknown): string | null {
  const digits = String(v ?? "").replace(/[\s-]/g, "");
  if (!/^\d{12}$/.test(digits)) return null;
  // UIDAI never issues a number starting 0 or 1 - the first digit is the cheapest real check there
  // is, and it catches a whole class of made-up values that would otherwise pass the checksum.
  if (digits[0] === "0" || digits[0] === "1") return null;
  return verhoeffOk(digits) ? digits : null;
}

export function aadhaarError(v: unknown, opts?: { optional?: boolean }): string | null {
  const s = String(v ?? "").trim();
  if (!s) return opts?.optional ? null : "Aadhaar number is required.";
  const digits = s.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return "Aadhaar number is 12 digits — letters and symbols are not part of it.";
  if (digits.length !== 12) return `Aadhaar number must be exactly 12 digits (this has ${digits.length}).`;
  if (digits[0] === "0" || digits[0] === "1") return "An Aadhaar number never begins with 0 or 1 — check the first digit.";
  // The message must not say "invalid". The number is almost always a real one typed slightly wrong,
  // and telling somebody their Aadhaar is invalid is both alarming and usually untrue.
  return verhoeffOk(digits) ? null : "That Aadhaar number does not check out — one digit is likely mistyped or two are swapped. Please compare it with the card.";
}

// ---- APAAR ID (2026-08-24, Umesh: "jaise abhi candidate id aati hai vaise hi govt APAAR ID hota
// hai, to ye bhi daal paayein for each one of the user team") ----
//
// APAAR = Automated Permanent Academic Account Registry - the student's 12-digit government academic
// account number (the same number the ABC / Academic Bank of Credits portal shows). A centre reads it
// off the portal exactly as it reads the CAN id, which is why it lives beside `sidh_candidate_id` and
// not beside `aadhaar_no`.
//
// DO NOT "HARMONISE" THIS WITH THE AADHAAR VALIDATOR ABOVE. They are both 12 digits and that is the
// whole of what they share. `aadhaarError` refuses any number beginning 0 or 1 and runs a Verhoeff
// check digit; the very first live APAAR value this product was given - Umesh's own screenshot,
// 190305516076 - BEGINS WITH 1, so routing it through that function would refuse a real id from the
// government's own screen. APAAR carries no published check digit, so the only honest test is the
// length and that it is all digits. A validator that invents a checksum it cannot verify would refuse
// correct data, which is worse than accepting a typo.
//
// Manual entry is STRICT (a human is at the keyboard and can be told); bulk import keeps the
// normalize-and-report lane and never drops a row over format - the QA-141 ruling, unchanged.

/** 12 bare digits, or null. Spaces and hyphens are how people write it and are not an error. */
export function canonicalApaar(v: unknown): string | null {
  const digits = String(v ?? "").replace(/[\s-]/g, "");
  return /^\d{12}$/.test(digits) ? digits : null;
}

export function apaarError(v: unknown, opts?: { optional?: boolean }): string | null {
  const s = String(v ?? "").trim();
  if (!s) return opts?.optional ? null : "APAAR ID is required.";
  const digits = s.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return "APAAR ID is 12 digits - letters and symbols are not part of it.";
  if (digits.length !== 12) return `APAAR ID must be exactly 12 digits (this has ${digits.length}).`;
  return null;
}

/**
 * QA-977 (-232 cycle 2, checker): "are these two government numbers THE SAME NUMBER" — asked as a
 * DIGITS comparison, in one place, by all four doors.
 *
 * READ THIS BEFORE SIMPLIFYING IT BACK. Every door used to ask the question through
 * `canonicalAadhaar()`, which is a **validity** test: it refuses any number beginning 0 or 1 and
 * runs a Verhoeff check digit. So the guard silently did nothing whenever the Aadhaar side was not
 * a *valid* Aadhaar — and the most important instance of that is **Umesh's own APAAR,
 * `190305516076`, which begins with 1**. `canonicalAadhaar("190305516076")` is `null`, the
 * comparison became `x === null`, and the edit door returned 200 and stored both government-ID
 * fields holding the same digits. The guard existed, was tested, and could not fire on the very
 * value the feature was built from.
 *
 * The irony is worth keeping on the page: the comment on `apaarError` above says in so many words
 * that APAAR must not be routed through the Aadhaar rules because a real one begins with 1 — and
 * the comparison was routed through them anyway. Equality is not validity. Ask equality.
 */
export const sameGovtNumber = (a: unknown, b: unknown): boolean => {
  const digits = (v: unknown) => String(v ?? "").replace(/[\s-]/g, "");
  const x = digits(a);
  return /^\d{12}$/.test(x) && x === digits(b);
};

/** QA-902: there IS a value on record and it is not a readable APAAR ID. The bulk importer stores
 *  what it reports (it never refuses a row), so a stored non-conforming value is a state that
 *  really occurs and the screen has to be able to say so rather than showing a blank. Asked in
 *  exactly one place, the same discipline `storedCanIsUnreadable` exists for. */
export const storedApaarIsUnreadable = (s: unknown) => {
  const raw = String(s ?? "").trim();
  return raw.length > 0 && canonicalApaar(raw) === null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function emailError(v: unknown, opts?: { optional?: boolean }): string | null {
  const s = String(v ?? "").trim();
  if (!s) return opts?.optional ? null : "Email is required.";
  return EMAIL_RE.test(s) ? null : "That does not look like an email address (name@domain.tld).";
}

// ---- The portal Candidate ID (SIDH "CAN" id) ----
//
// These three live HERE, in the pure module, and `lib/govt-attendance.ts` re-exports them for the
// server callers that have always imported them from there. -212 (QA-728): they were in
// govt-attendance, which imports the mongoose models, so no client component could touch them - and
// the batch screen had already grown its OWN inline `/CAN[\s_-]*(\d+)/i` rather than import one.
// That is the fifth spelling of a concept whose line in ARCHITECTURE.md section 3 reads "Never
// write a near-copy of that regex". A pure module is the only home that both sides can share.

/**
 * -155: ONE normalisation of the portal CAN id. Reads only the DIGITS after CAN.
 * Everything that decides WHO MATCHES WHOM goes through this: the certification gate, the
 * certificate matcher, the health screen, link-portal-ids.
 */
export const normalizeCan = (s: unknown): string | null => {
  const m = /CAN[\s_-]*(\d+)/i.exec(String(s ?? ""));
  return m ? "CAN" + m[1] : null;
};

/**
 * QA-714 (-210): the SHAPE test for a HAND-TYPED value - begins with CAN, carries at least one
 * digit. Deliberately NOT `normalizeCan`: that is the matcher, and using it as a format refused
 * `CAN_ED0711202`, a shape this product stores. Eleven wall assertions caught that before it shipped.
 *
 * Known and deliberate: this accepts ids `normalizeCan` cannot read. Widening the matcher is QA-719
 * and is Umesh's decision, not a side effect of a validation release - so where the two disagree the
 * screen SAYS so, via storedCanIsUnreadable, instead of showing a blank.
 */
export const looksLikeCan = (s: unknown) => /^\s*CAN[\s_-]?[A-Za-z0-9-]*\d[A-Za-z0-9-]*\s*$/i.test(String(s ?? ""));

/** QA-725: there IS a value on record and this system cannot read it. Asked in exactly one place. */
export const storedCanIsUnreadable = (s: unknown) => {
  const raw = String(s ?? "").trim();
  return raw.length > 0 && normalizeCan(raw) === null;
};
