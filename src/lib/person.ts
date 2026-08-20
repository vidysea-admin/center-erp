// -161 (QA-484): ONE definition of how this product names a person - and in a module BOTH sides
// can import. It lived in lib/client.ts, which opens with "use client", so no API route could
// reach it: seven server-side copies of the same sentence existed for that reason, including one
// inside lib/duplicates.ts - the message the duplicate-CANDIDATE detector prints, which is the
// feature whose whole job is telling two people apart.
//
// REQ-389: "the portal ID when present, otherwise the phone". A name alone is never sufficient
// identification on a screen a person acts on.

// -159 cycle 2 (QA-481): ONE definition of how this product names a person, for every screen.
// The release that collapsed four copies of this rule inside one file created a THIRD app-wide
// copy while doing it - page.tsx had personLabel, candidates/page.tsx renders `${m.name}${m.phone
// ? ` (${m.phone})` : ""}` on the Portal ID health screen (the very screen the -158 tooltip links
// to), and trainers/page.tsx renders `${d.name} (${d.phones.join(" / ")})`. Three implementations
// of one sentence, and the duplication map did not carry the row.
//
// REQ-389 decides the shape: the portal ID when present, otherwise the phone. Both singular
// `phone` and plural `phones` are accepted because trainers carry a list and candidates carry one
// - that difference is real data, not drift, and forcing either side to convert would just move
// the duplication somewhere quieter.
export function personLabel(x?: {
  name?: string | null;
  sidh_candidate_id?: string | null;
  phone?: string | null;
  phones?: Array<string | null | undefined> | null;
} | null): string {
  const name = String(x?.name ?? "").trim();
  if (!name) return "";
  // -161 (QA-486): REQ-389 in full - "the portal ID when present, OTHERWISE the phone". -160 shipped
  // only the second half while quoting the whole sentence in four places. The order matters beyond
  // pedantry: the portal ID is the identity the government issues and the one a centre quotes back
  // to it, so where a student has one it is the better separator; the phone is the fallback for
  // everyone who does not, which is exactly who the portal-ID lists are about.
  const can = String(x?.sidh_candidate_id ?? "").trim();
  if (can) return `${name} (${can})`;
  const phones = (Array.isArray(x?.phones) ? x!.phones! : [x?.phone]).map((p) => String(p ?? "").trim()).filter(Boolean);
  return phones.length ? `${name} (${phones.join(" / ")})` : name;
}

// -161 (QA-430): the same rule as personLabel for surfaces that render the name themselves and want
// only the separator beneath it (the Attendance NameCell's `sub`). One rule, two shapes, one place.
export function personSeparator(x?: Parameters<typeof personLabel>[0]): string {
  const can = String(x?.sidh_candidate_id ?? "").trim();
  if (can) return can;
  const phones = (Array.isArray(x?.phones) ? x!.phones! : [x?.phone]).map((p) => String(p ?? "").trim()).filter(Boolean);
  return phones[0] ?? "";
}

export const personList = (
  xs?: Array<Parameters<typeof personLabel>[0]> | null,
) => (xs ?? []).map(personLabel).filter(Boolean).join(", ");
