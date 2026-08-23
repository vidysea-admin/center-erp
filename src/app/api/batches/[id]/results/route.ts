import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BatchMember, Candidate, CandidateResult } from "@/models";
import { assertBatchInScope, bulkMarkResults, summarizeBatchResults } from "@/lib/rules";
import { looksLikeCan } from "@/lib/validate";
import { audit } from "@/lib/audit";

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
  const members = await BatchMember.find({ batch: id }).populate("candidate", "name phone lifecycle_status sidh_candidate_id").sort({ joined_on: 1 }).lean<any[]>();
  const rows = await CandidateResult.find({ batch: id }).lean<any[]>();
  const byCandidate = new Map(rows.map((r) => [String(r.candidate), r]));

  const items = members.map((m) => ({
    member: String(m._id),
    candidate: m.candidate,
    joined_on: m.joined_on,
    left_on: m.left_on,
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
    "mock_appeared", "mock_qualified", "mock_score", "mock_note", "roll_no"];
  const rows = body.rows.map((r: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => allowed.includes(k))));

  // QA-747 (-214, Umesh 23/08): "role number nai chayye, candidate id chayye. Candidate id fill
  // karne ke liye woh hona chahiye, taaki jin students ki candidate id missing hai unko wo kar
  // payein." The card's `Roll no` box was filled 0 times out of 45 on the live batch; the thing a
  // centre actually needs there is the portal Candidate ID.
  //
  // It is written HERE, on this door, and not through PATCH /api/candidates/:id - deliberately, and
  // it is his call. This card opens on `closure.manage`, which a TRAINER has; the candidate door
  // wants `candidates.manage`, which a Trainer does not. Putting the box on the card and the write
  // on that door would have shown every Trainer an input that 403s on save - the dead-button class
  // that shipped three times in three releases (QA-712, QA-723, QA-754). Asked directly, Umesh said
  // "Trainer bhi bhar sake", so the write lives on the door the card already has.
  //
  // `sidh_candidate_id` belongs to Candidate, not CandidateResult, so it is pulled out BEFORE the
  // allow-list above rather than added to it.
  const canRows: { member: string; raw: string | null }[] = [];
  for (const r of body.rows as Record<string, unknown>[]) {
    if (!("sidh_candidate_id" in r)) continue;
    const v = r.sidh_candidate_id;
    canRows.push({ member: String(r.member), raw: typeof v === "string" && v.trim() ? v.trim() : null });
  }
  // Validate EVERY id before writing ANYTHING. -206 and -213 both shipped a door that wrote first
  // and refused afterwards; this one refuses first.
  for (const c of canRows) {
    if (c.raw && !looksLikeCan(c.raw)) {
      throw new HttpError(400, `"${c.raw}" is not a portal Candidate ID. It reads like CAN_12345678 - the letters CAN followed by the number. Copy it from SIDH exactly as it appears there. Nothing has been saved.`);
    }
  }

  // QA-780 (-216, checker on qa-214): resolve and PRE-CHECK every id write before anything is
  // written. -214 wrote the ids and then let the result-marking throw 400, and let a duplicate id
  // throw 409 mid-loop - so a request whose own message says "Nothing has been saved" had already
  // saved and audited an identity field. That is the same write-then-refuse class as QA-697 and
  // QA-751, on a smaller surface but the same shape, and the door had just been given a THIRD
  // caller. Resolve, check uniqueness, then write - and let the result errors fire first.
  const planned: { cand: any; was: string; raw: string | null }[] = [];
  // QA-786 (-217, checker on qa-216): the pre-check asked only the DATABASE, so two rows in ONE
  // request naming the same new id both passed it - the first was written and audited, and the
  // partial unique index then threw 409 on the second. The id was saved by a request that refused.
  // QA-780 survived exactly one path, and it was the path where the conflict does not exist yet.
  const claimedHere = new Map<string, string>();
  for (const c of canRows) {
    const m = await BatchMember.findOne({ _id: c.member, batch: id }).select("candidate").lean<any>();
    if (!m?.candidate) continue;
    const cand = await Candidate.findById(m.candidate);
    if (!cand) continue;
    const was = String(cand.sidh_candidate_id ?? "").trim();
    // QA-726: only where the value actually CHANGED. Re-validating an unchanged value is what made
    // records already holding a bad id uneditable in every other field.
    if (was === String(c.raw ?? "")) continue;
    if (c.raw) {
      // QA-417's partial unique index would throw E11000 halfway through the loop, after earlier
      // rows had already been written. Asked here instead, so the refusal costs nothing.
      const clash = await Candidate.findOne({ sidh_candidate_id: c.raw, _id: { $ne: cand._id } }).select("name").lean<any>();
      if (clash) {
        throw new HttpError(409, `"${c.raw}" is already the portal Candidate ID of ${clash.name ?? "another candidate"}. Nothing has been saved.`);
      }
      // …and against the ids this same request is about to claim.
      const twin = claimedHere.get(c.raw);
      if (twin && twin !== String(cand._id)) {
        throw new HttpError(409, `"${c.raw}" was given to two different students in the same save. A portal Candidate ID belongs to one person. Nothing has been saved.`);
      }
      claimedHere.set(c.raw, String(cand._id));
    }
    planned.push({ cand, was, raw: c.raw });
  }

  const res = await bulkMarkResults(id, rows, user.id);
  if (res.updated === 0 && res.errors.length) throw new HttpError(400, res.errors[0].error);

  for (const w of planned) {
    w.cand.sidh_candidate_id = w.raw as any;
    await w.cand.save();
    await audit({ entity: "Candidate", entityId: w.cand._id, field: "sidh_candidate_id",
      oldValue: w.was || null, newValue: w.raw ?? null, actor: user.id, actorType: "USER" });
  }
  const after = await CandidateResult.find({ batch: id }).lean<any[]>();
  return NextResponse.json({ ...res, summary: await summarizeBatchResults(id, after) });
});
