import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { CandidateResult, Closure } from "@/models";
import { assertBatchInScope, recomputeClosureAggregates } from "@/lib/rules";
import { audit } from "@/lib/audit";

// QA-044 (checker, 14/08): a legacy batch (completed outside per-candidate mode, closure
// document never created) showed "0 passed derived" while seven marked rows held
// certificates. This endpoint derives the closure FROM the rows — and only when there is
// no recorded closure to protect: an existing closure stays frozen (DEC-6 / Rule 42-S0),
// because on legacy batches its batch-level figures may cover a wider roster than the
// late-arrival rows do. Per-candidate-mode batches never need this (every upsert already
// recomputes).
export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage");
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38

  const rowCount = await CandidateResult.countDocuments({ batch: id });
  if (!rowCount) throw new HttpError(400, "No per-candidate results to derive from — mark candidates (or upload certificates) first.");
  if (await Closure.exists({ batch: id })) {
    throw new HttpError(409, "This batch already has a recorded closure — its figures are frozen (2026-08-13 decision). Derivation only fills an absent record.");
  }

  const summary = await recomputeClosureAggregates(id, user.id);
  await audit({ entity: "Closure", entityId: id, field: "derive", newValue: `closure derived from ${rowCount} per-candidate row(s): appeared ${summary.appeared}, passed ${summary.passed}, certificates ${summary.certificates_issued}`, actor: user.id });
  return NextResponse.json({ summary }, { status: 201 });
});
