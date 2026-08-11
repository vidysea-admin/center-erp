import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { CandidateResult } from "@/models";
import { assertResultInScope, upsertCandidateCertificate, upsertCandidateResult } from "@/lib/rules";
import { audit } from "@/lib/audit";

const ASSESSMENT_FIELDS = ["result", "score", "max_score", "assessed_on", "assessor", "failure_reason", "failure_note", "reassessment_required", "reassessment_date", "evidence_file"];
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
