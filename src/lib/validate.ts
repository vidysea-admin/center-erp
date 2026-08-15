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
