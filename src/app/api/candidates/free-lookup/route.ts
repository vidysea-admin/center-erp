import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, readJson, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate, BatchMember } from "@/models";
import { HOLDS_PERSON } from "@/lib/candidate-journey";
import { looksLikeCan, normalizeCan } from "@/lib/govt-attendance";
import { canonicalPhone } from "@/lib/validate";
import { maskPhone } from "@/lib/duplicates";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";

// -342 (Umesh 2026-11-03): a free student belongs to no centre, so a scoped user (Center Manager, Location,
// scoped Enrollment) must be able to bring in a student who last studied elsewhere. The batch picker lists
// only the centres the user can see (Rule 38), so this is the way to the rest: an EXACT lookup by one
// 10-digit mobile or one portal CAN id.
//
// It is a deliberately narrow door, because it answers across centres:
//   - exact match only (no search, no prefix, no fuzzy), one value per request;
//   - ONLY free, unarchived students: anyone a running batch holds, anyone archived and anyone marked
//     "interested in the Upcoming batch" (who cannot be enrolled yet) is indistinguishable from "no such
//     student" - the caller learns nothing about students who are not theirs to take;
//   - an explicit field list: name, masked phone, CAN, last centre and course. Never DOB, Aadhaar, APAAR,
//     address, email or the full number;
//   - candidates.assign, the right that adds a student to a batch, and nothing else opens it;
//   - rate limited per user, and every lookup audited (the audit row masks the number too).
// POST, not GET, so the mobile / CAN never lands in an access log or a browser history as a URL.
const LOOKUP_MAX = 30;
const LOOKUP_WINDOW_MS = 10 * 60_000;
type Found = { _id: unknown; name: string; phone?: string; sidh_candidate_id?: string; location?: { name?: string } | null; program?: { name?: string } | null };
const MAX_RESULTS = 5; // a household shares one mobile; more than a handful is not a lookup any more

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "candidates.assign");
  rateLimit(`free-lookup:${user.id}`, LOOKUP_MAX, LOOKUP_WINDOW_MS);
  const body = await readJson(req);
  const q = typeof body.q === "string" ? body.q.trim() : "";

  // One kind of query per request: a CAN id (starts with the letters CAN) or a 10-digit mobile.
  let filter: Record<string, unknown>;
  let canon: string | null = null;
  let kind: "CAN" | "mobile";
  if (/^\s*CAN/i.test(q)) {
    canon = looksLikeCan(q) ? normalizeCan(q) : null;
    if (!canon) throw new HttpError(400, "That is not a portal Candidate ID. It reads like CAN_12345678 - the letters CAN followed by the number.");
    kind = "CAN";
    // narrow in the database by the digit run, then confirm with the SAME matcher every other reader uses
    filter = { sidh_candidate_id: { $regex: `CAN[\\s_-]*${canon.slice(3)}(?![0-9])`, $options: "i" } };
  } else {
    const phone = canonicalPhone(q);
    if (!phone) throw new HttpError(400, "Enter the student's full 10-digit mobile number, or their CAN ID.");
    kind = "mobile";
    filter = { phone: { $regex: `${phone}$` } };
  }

  let found = await Candidate.find({ ...filter, archived_at: null, batch_interest: { $ne: "Future" } })
    .select("name phone sidh_candidate_id location program")
    .populate("location", "name").populate("program", "name")
    .limit(MAX_RESULTS * 4).lean<Found[]>();
  if (canon) found = found.filter((c) => normalizeCan(c.sidh_candidate_id) === canon);
  if (kind === "mobile") found = found.filter((c) => canonicalPhone(c.phone) === canonicalPhone(q));
  if (found.length) {
    const held = new Set((await BatchMember.find({ candidate: { $in: found.map((c) => c._id) }, ...HOLDS_PERSON }).select("candidate").lean<{ candidate: unknown }[]>()).map((m) => String(m.candidate)));
    found = found.filter((c) => !held.has(String(c._id)));
  }
  found = found.slice(0, MAX_RESULTS);

  const items = found.map((c) => ({
    _id: String(c._id),
    name: c.name,
    phone_masked: maskPhone(c.phone),
    can: c.sidh_candidate_id ?? null,
    centre: c.location?.name ?? null,
    course: c.program?.name ?? null,
  }));

  // Audited against each student found; a lookup that finds nobody is audited on the caller (entity_id is
  // required and there is no student to name). Never the full number or CAN - the last four digits only.
  const what = `${kind} ending ${(kind === "CAN" ? canon! : canonicalPhone(q)!).slice(-4)}`;
  for (const c of found) {
    await audit({ entity: "Candidate", entityId: c._id, field: "free_lookup", newValue: `found by ${what} (free-student lookup, to add to a batch)`, actor: user.id });
  }
  if (!found.length) {
    await audit({ entity: "User", entityId: user.id, field: "free_lookup", newValue: `${what}: no free student matched`, actor: user.id });
  }
  return NextResponse.json({ items });
});
