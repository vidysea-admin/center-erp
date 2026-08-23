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
