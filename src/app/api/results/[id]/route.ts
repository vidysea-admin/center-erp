import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, CandidateResult, Closure } from "@/models";
import { assertResultInScope, recomputeClosureAggregates, upsertCandidateCertificate, upsertCandidateResult } from "@/lib/rules";
import { audit } from "@/lib/audit";

// A-09: `eligibility_override_reason` rides here too. This is the SECOND door onto the same write
// function, and the guard it enforces is not the route's - it is upsertCandidateResult's. If only
// one of the two doors carried the field, a Pass that succeeds from the card would be refused from
// here with a message the operator had already answered. Both doors, one rule.
const ASSESSMENT_FIELDS = ["result", "score", "max_score", "assessed_on", "assessor", "failure_reason", "failure_note", "reassessment_required", "reassessment_date", "evidence_file", "eligibility_override_reason"];
const CERT_FIELDS = ["certificate_status", "certificate_no", "certificate_date", "certificate_file", "certificate_rejection_reason"];

// PATCH one candidate's row. Assessment and certificate fields are routed to their own
// rule functions so each keeps its own guards (Rules 44/45/46).
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertResultInScope(user, id); // Rule 38 — the easiest scoping hole to leave open

  const body = await req.json();
  const assessment = Object.fromEntries(Object.entries(body).filter(([k]) => ASSESSMENT_FIELDS.includes(k)));
  const certificate = Object.fromEntries(Object.entries(body).filter(([k]) => CERT_FIELDS.includes(k)));

  let row = await CandidateResult.findById(id).lean<any>();
  if (Object.keys(assessment).length) {
    row = await upsertCandidateResult(String(row.batch), String(row.batch_member), assessment, user.id);
  }
  if (Object.keys(certificate).length) {
    row = await upsertCandidateCertificate(id, certificate, user.id);
  }
  await audit({ entity: "CandidateResult", entityId: id, field: "result", newValue: { ...assessment, ...certificate }, actor: user.id });
  return NextResponse.json({ item: row });
});

// DELETE { reason } — un-mark a candidate entirely (-103).
//
// Found by the -102 cleanup actually running: the new member-removal door refused to take the
// maker's two test rows off the empty Gurugram batch because each carried a Pass result, and there
// was NO way to remove a CandidateResult — only PATCH it to a different value. The guard was right;
// the gap was real. Two consequences, both live:
//   1. A row created on the wrong candidate was permanent. It could be edited to "Pending", but a
//      row that should never have existed still counted as a row.
//   2. `legacy` is decided by "this batch has zero CandidateResult rows" (the whole back-compat
//      strategy). One accidental row therefore flipped a batch to per-candidate marking FOREVER,
//      and its closure figures derive from those rows — so two fake passes on a Planning batch
//      would have become two real passes in the client's numbers the moment it was filled in.
//
// Narrow on purpose, same shape as the -101 certificate door:
//   - DEC-6 freeze: a Completed or Cancelled batch is locked, no admin override.
//   - An ATTESTED closure blocks it: once someone has signed off assessment or certification, the
//     figures have been reported and a row may not be pulled out from under them.
//   - A certificate FILE blocks it: remove the file first (that door exists and audits its own
//     reason), so this can never orphan an object in the bucket.
//   - A reason is required, and the audit carries the whole row, because un-marking destroys the
//     assessment history including every reassessment attempt.
export const DELETE = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage");
  const { id } = await ctx.params;
  await assertResultInScope(user, id); // Rule 38

  const row = await CandidateResult.findById(id).populate("candidate", "name").lean<any>();
  if (!row) throw new HttpError(404, "Result not found");

  const { reason } = await req.json().catch(() => ({}));
  if (!reason || !String(reason).trim()) {
    throw new HttpError(400, "A reason is required — un-marking destroys the assessment history for this candidate, including any reassessment attempts.");
  }

  const batch = await Batch.findById(row.batch).select("status code").lean<any>();
  if (["Completed", "Cancelled"].includes(batch?.status)) {
    throw new HttpError(409, "The batch is closed — its results are frozen (2026-08-13 decision: a Completed batch stays locked).");
  }
  if (row.certificate_file) {
    throw new HttpError(409, "This row still points at a certificate file. Remove the certificate first (that step is audited on its own), then un-mark the candidate — otherwise the stored file would be left unreachable in the bucket.");
  }
  const closure = await Closure.findOne({ batch: row.batch }).select("assessment_status certification_status assessment_derived certification_derived").lean<any>();
  // -112 (QA-219): sign-off can now DERIVE from the rows. A derived one must not slam this door —
  // nothing was reported, and removing the row simply un-derives it (deriveCompletion walks it back
  // in the same request). A HUMAN attestation still blocks, which is what this guard was written for.
  const humanSignoff = (closure?.assessment_status === "Completed" && !closure?.assessment_derived)
    || (closure?.certification_status === "Completed" && !closure?.certification_derived);
  if (closure && humanSignoff) {
    throw new HttpError(409, `Assessment or certification has already been signed off for ${batch?.code ?? "this batch"}, so the figures have been reported — a candidate's row cannot be pulled out from under them. Correct the row with an edit instead.`);
  }

  await CandidateResult.deleteOne({ _id: row._id });
  const left = await CandidateResult.countDocuments({ batch: row.batch });
  await audit({
    entity: "CandidateResult", entityId: row._id, field: "removed",
    oldValue: {
      candidate: row.candidate?.name ?? String(row.candidate), batch: batch?.code,
      result: row.result, score: row.score, max_score: row.max_score, assessed_on: row.assessed_on,
      certificate_status: row.certificate_status, certificate_no: row.certificate_no,
      attempts: (row.attempts ?? []).length,
    },
    newValue: `un-marked — ${String(reason).trim()}${left === 0 ? " (last row on the batch: it returns to batch-level figures)" : ""}`,
    actor: user.id, actorType: "USER",
  });
  // -112: the rows just changed, so anything DERIVED from them has to be restated — otherwise a
  // sign-off derived a moment ago keeps standing after the row it was derived from is gone.
  if (left > 0) await recomputeClosureAggregates(String(row.batch), user.id);
  return NextResponse.json({ ok: true, rows_left_on_batch: left, batch_returns_to_legacy: left === 0 });
});
