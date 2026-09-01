import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BatchMember, Candidate, CandidateResult } from "@/models";
import { assertBatchInScope, bulkMarkResults, summarizeBatchResults } from "@/lib/rules";
import { looksLikeCan, normalizeCan, apaarError, canonicalApaar, canonicalAadhaar, sameGovtNumber } from "@/lib/validate";
import { audit } from "@/lib/audit";

const CAN_SHAPE = /CAN/i;

// GET — every roster member left-joined to its result row, so the marking grid renders
// before anything has been marked. Pure read: no writes, no aggregate recompute (Rule 41).
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38

  // -108: sidh_candidate_id rides along so the closure screen can show the EXACT file name the
  // certificate matcher would accept for each candidate, instead of a generic "CAN_12345.pdf"
  // format hint that told a trainer nothing about their own batch.
  const members = await BatchMember.find({ batch: id }).populate("candidate", "name phone lifecycle_status sidh_candidate_id apaar_id aadhaar_no").sort({ joined_on: 1 }).lean<any[]>();
  const rows = await CandidateResult.find({ batch: id }).lean<any[]>();
  const byCandidate = new Map(rows.map((r) => [String(r.candidate), r]));

  const items = members.map((m) => ({
    member: String(m._id),
    candidate: m.candidate,
    joined_on: m.joined_on,
    left_on: m.left_on,
    // 2026-08-25: rides beside left_on so the closure card can name the leave the way the Candidates
    // roster already does - "left 25 Aug 2026 (Not interested)" - instead of a bare "dropped". Same
    // event, two screens, one sentence.
    drop_reason: m.drop_reason ?? null,
    enrollment_status: m.enrollment_status,
    result: byCandidate.get(String(m.candidate?._id ?? m.candidate)) ?? null,
  }));
  return NextResponse.json({ items, summary: await summarizeBatchResults(id, rows), legacy: rows.length === 0 });
});

// PUT — bulk mark. Body: { rows: [{ member, result, score, ... }] }
export const PUT = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const body = await req.json();
  if (!Array.isArray(body.rows) || !body.rows.length) throw new HttpError(400, "rows[] is required");

  const allowed = ["member", "result", "score", "max_score", "assessed_on", "assessor", "failure_reason", "failure_note", "reassessment_required", "reassessment_date", "evidence_file",
    // -120 (M4-14): the mock test and the roll number, per candidate. The -116 lesson applies — a
    // field the route does not accept is a field that silently drops on save.
    "mock_appeared", "mock_qualified", "mock_score", "mock_note", "roll_no",
    // A-09: this list is an ALLOW-LIST, so a field it does not name is a field that never reaches
    // the rule. The guard in upsertCandidateResult demands this reason before it will Pass a
    // not-eligible candidate; without it here the reason would be stripped in transit and every
    // override would be refused with an error the operator had already answered. qa-246 shipped
    // exactly this shape in the other direction (the server sent a field the screen's picker
    // dropped) - same lesson, opposite end of the wire.
    "eligibility_override_reason"];
  const rows = body.rows.map((r: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => allowed.includes(k))));

  // QA-747 (-214, Umesh 23/08): "role number nai chayye, candidate id chayye. Candidate id fill
  // karne ke liye woh hona chahiye, taaki jin students ki candidate id missing hai unko wo kar
  // payein." The card's `Roll no` box was filled 0 times out of 45 on the live batch; the thing a
  // centre actually needs there is the portal Candidate ID.
  //
  // It is written HERE, on this door, and not through PATCH /api/candidates/:id - deliberately, and
  // it is his call. This card opens on `closure.manage`, which a Trainer does NOT hold by default
  // (permissions.ts: Trainer's fixed set is just `batches.daily_log`) - QA-781 (checker on qa-214)
  // caught this comment claiming otherwise. It is grantable per-deployment through the live
  // permission matrix (togglable, 2026-08-11), which is what makes "Trainer bhi bhar sake" true when
  // it is; the candidate door wants `candidates.manage`, a different, ungrantable-to-Trainer-here
  // right. Putting the box on the card and the write
  // on that door would have shown every Trainer an input that 403s on save - the dead-button class
  // that shipped three times in three releases (QA-712, QA-723, QA-754). Asked directly, Umesh said
  // "Trainer bhi bhar sake", so the write lives on the door the card already has.
  //
  // `sidh_candidate_id` belongs to Candidate, not CandidateResult, so it is pulled out BEFORE the
  // allow-list above rather than added to it.
  //
  // QA-902 (2026-08-24, Umesh: "jaise abhi candidate id aati hai vaise hi govt APAAR ID hota hai...
  // card mein iske liye bhi jagah banao same as candidate id"): there are now TWO candidate identity
  // fields written through this door, and this block is NOT duplicated for the second one. What used
  // to be a bespoke sidh_candidate_id path is one loop over the table below, because everything that
  // makes this block correct was learned the expensive way and applies identically to both:
  //   -206 / -213  refuse before writing ANYTHING, never write-then-refuse
  //   QA-780       resolve and pre-check every id before the first save
  //   QA-786       ...including against the ids THIS SAME REQUEST is about to claim
  //   QA-726       only where the value actually CHANGED, or records holding a bad value freeze
  //   QA-417       the partial unique index would otherwise throw E11000 mid-loop
  //   QA-730       store what was validated, without the whitespace the index would miss
  // A near-copy of all six for field two is exactly what ARCHITECTURE.md section 3 exists to stop.
  const ID_FIELDS = [
    {
      key: "sidh_candidate_id", label: "portal Candidate ID",
      ok: (s: string) => looksLikeCan(s),
      canon: (s: string) => s.trim(),
      // QA-793 (checker on qa-217, cycle 3): CAN_x / can_x / CAN-x / "CAN x" all read as one
      // identity everywhere else this field is matched (certificates, the health screen, QA-447's
      // own create/edit doors) - normalizeCan is documented as THE matcher for exactly that reason
      // ("Everything that decides WHO MATCHES WHOM goes through this", lib/validate.ts). This door
      // used to key its uniqueness on the raw, as-typed string, so two differently-spelled
      // spellings of one real portal ID passed both the DB pre-check and the same-request check
      // and were handed to two different students. `?? s` falls back to the raw string only when
      // normalizeCan cannot read the value at all - never silently treating two unreadable ids as
      // the same identity by coincidence.
      matchKey: (s: string) => normalizeCan(s) ?? s,
      findClash: async (next: string, excludeId: string) => {
        const holders = await Candidate.find({ sidh_candidate_id: CAN_SHAPE, _id: { $ne: excludeId } })
          .select("name sidh_candidate_id").lean<any[]>();
        const want = normalizeCan(next) ?? next;
        return holders.find((h) => (normalizeCan(h.sidh_candidate_id) ?? h.sidh_candidate_id) === want) ?? null;
      },
      formatError: (raw: string) => `"${raw}" is not a portal Candidate ID. It reads like CAN_12345678 - the letters CAN followed by the number. Copy it from SIDH exactly as it appears there. Nothing has been saved.`,
      crossCheck: () => null,
    },
    {
      key: "apaar_id", label: "APAAR ID",
      ok: (s: string) => apaarError(s, { optional: true }) === null,
      canon: (s: string) => canonicalApaar(s)!,
      // APAAR is stored canonicalized on every writer (canonicalApaar runs before the save below),
      // so the stored value already IS its own match key - a plain exact query is correct and
      // needs no fuzzy matching (unlike the portal ID above, which is stored exactly as typed).
      matchKey: (s: string) => s,
      findClash: (next: string, excludeId: string) =>
        Candidate.findOne({ apaar_id: next, _id: { $ne: excludeId } }).select("name").lean<any>(),
      formatError: (raw: string) => `${apaarError(raw, { optional: true })} Nothing has been saved.`,
      // The QA-414 guard. APAAR and Aadhaar are BOTH 12 digits, and models/index.ts records that 55
      // live candidates already had a government id typed into the wrong box once. This is the one
      // confusion that is knowable at the door, so it is refused here by name instead of being
      // discovered when the portal rejects that student.
      crossCheck: (cand: any, next: string) =>
        sameGovtNumber(next, cand?.aadhaar_no)
          ? `That is ${cand?.name ?? "this candidate"}'s Aadhaar number, not their APAAR ID. They are both 12 digits and are different numbers - the APAAR ID is the academic account number from the government portal. Nothing has been saved.`
          : null,
    },
  ] as const;

  type IdWant = { member: string; field: (typeof ID_FIELDS)[number]; raw: string | null };
  const wants: IdWant[] = [];
  for (const r of body.rows as Record<string, unknown>[]) {
    for (const f of ID_FIELDS) {
      if (!(f.key in r)) continue;
      const v = r[f.key];
      wants.push({ member: String(r.member), field: f, raw: typeof v === "string" && v.trim() ? v.trim() : null });
    }
  }
  // Validate EVERY id before writing ANYTHING. -206 and -213 both shipped a door that wrote first
  // and refused afterwards; this one refuses first.
  for (const w of wants) {
    if (w.raw && !w.field.ok(w.raw)) throw new HttpError(400, w.field.formatError(w.raw));
  }

  // QA-780 (-216, checker on qa-214): resolve and PRE-CHECK every id write before anything is
  // written. -214 wrote the ids and then let the result-marking throw 400, and let a duplicate id
  // throw 409 mid-loop - so a request whose own message says "Nothing has been saved" had already
  // saved and audited an identity field. That is the same write-then-refuse class as QA-697 and
  // QA-751, on a smaller surface but the same shape, and the door had just been given a THIRD
  // caller. Resolve, check uniqueness, then write - and let the result errors fire first.
  const planned: { cand: any; field: (typeof ID_FIELDS)[number]; was: string; next: string | null }[] = [];
  // QA-786 (-217, checker on qa-216): the pre-check asked only the DATABASE, so two rows in ONE
  // request naming the same new id both passed it - the first was written and audited, and the
  // partial unique index then threw 409 on the second. The id was saved by a request that refused.
  // QA-780 survived exactly one path, and it was the path where the conflict does not exist yet.
  // Keyed by FIELD as well as value, or an APAAR would collide with a CAN id that happened to match.
  const claimedHere = new Map<string, string>();
  // QA-902: one mongoose document per candidate, loaded ONCE and shared. With two id fields on this
  // door a single request can now change both on the same person, and two separate findById copies
  // would each save their own field over the other's - the second write silently undoing the first.
  // That failure did not exist while this loop handled one field, which is precisely why it has to
  // be dealt with here rather than left for whoever adds field three.
  const docs = new Map<string, any>();
  for (const w of wants) {
    const m = await BatchMember.findOne({ _id: w.member, batch: id }).select("candidate left_on").lean<any>();
    if (!m?.candidate) continue;
    // 2026-08-25: the SECOND door on this route. These two id fields are written here, independently
    // of bulkMarkResults - so on a multi-row save where one member has left, res.updated is still > 0,
    // the throw below never fires, and the departed member's identity fields would be rewritten by
    // a request the screen no longer offers. The closure card is read-only for them; a scripted POST
    // gets the same answer.
    //
    // A skip, NOT a throw, and deliberately: this loop refuses the WHOLE request before writing
    // anything, so turning one departed row into a hard 400 would drop a forty-six-row save on
    // account of a row nobody was shown.
    if (m.left_on) continue;
    const cid = String(m.candidate);
    let cand = docs.get(cid);
    if (!cand) {
      cand = await Candidate.findById(m.candidate);
      if (!cand) continue;
      docs.set(cid, cand);
    }
    const was = String(cand[w.field.key] ?? "").trim();
    const next = w.raw ? w.field.canon(w.raw) : null;
    // QA-726: only where the value actually CHANGED. Re-validating an unchanged value is what made
    // records already holding a bad id uneditable in every other field.
    if (was === String(next ?? "")) continue;
    if (next) {
      const cross = w.field.crossCheck(cand, next);
      if (cross) throw new HttpError(400, cross);
      // QA-417's partial unique index would throw E11000 halfway through the loop, after earlier
      // rows had already been written. Asked here instead, so the refusal costs nothing.
      // QA-793: findClash (per field, above) reads what actually collides - a byte-exact query for
      // apaar_id (already canonical on write), a normalizeCan-matched scan for sidh_candidate_id
      // (stored as typed, so "CAN_x"/"can_x"/"CAN-x" must all be read as the one identity they are
      // everywhere else this field is matched).
      const clash = await w.field.findClash(next, String(cand._id));
      if (clash) {
        throw new HttpError(409, `"${next}" is already the ${w.field.label} of ${clash.name ?? "another candidate"}. Nothing has been saved.`);
      }
      // …and against the ids this same request is about to claim, keyed the SAME normalized way -
      // CAN_16114311 onto one row and can_16114311 onto another must collide here too.
      const ck = `${w.field.key}:${w.field.matchKey(next)}`;
      const twin = claimedHere.get(ck);
      if (twin && twin !== String(cand._id)) {
        throw new HttpError(409, `"${next}" was given to two different students in the same save. A ${w.field.label} belongs to one person. Nothing has been saved.`);
      }
      claimedHere.set(ck, String(cand._id));
    }
    planned.push({ cand, field: w.field, was, next });
  }

  const res = await bulkMarkResults(id, rows, user.id);
  if (res.updated === 0 && res.errors.length) throw new HttpError(400, res.errors[0].error);

  // Set every planned field first, then save each candidate ONCE (see the `docs` note above), then
  // audit — one row per field, so a save that changed both ids leaves two separate trail entries.
  for (const p of planned) p.cand[p.field.key] = p.next as any;
  for (const cand of new Set(planned.map((p) => p.cand))) await cand.save();
  for (const p of planned) {
    await audit({ entity: "Candidate", entityId: p.cand._id, field: p.field.key,
      oldValue: p.was || null, newValue: p.next ?? null, actor: user.id, actorType: "USER" });
  }
  const after = await CandidateResult.find({ batch: id }).lean<any[]>();
  return NextResponse.json({ ...res, summary: await summarizeBatchResults(id, after) });
});
