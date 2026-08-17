import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, CandidateResult } from "@/models";
import { assertResultInScope } from "@/lib/rules";
import { removeStoredFile } from "@/lib/storage";
import { audit } from "@/lib/audit";

// -101 (Umesh, 17/08: "CRUD ke saare operations chalne chahiye"): the D that did not exist.
// A certificate could be UPLOADED and REPLACED but never removed — so a certificate attached to
// the wrong candidate, or a scan of the wrong page, was permanent, and the stored object could
// never be reclaimed (`DELETE /api/files/<name>` refuses it, correctly, because the result row
// still points at it).
//
// Scope is deliberately narrow: this removes the FILE and nothing else. It does NOT touch
// `certificate_status` — Rule 46 owns that transition and demands a number for Generated or a
// reason for Rejected/Not Issued, so a file deletion silently walking the status would either
// break those guards or invent data. The status stays where it was; PATCH /api/results/<id> is
// still the door for changing it. The number and date likewise stay: they are what the awarding
// body issued, and they do not stop being true because the scan was wrong.
//
// DEC-6 still rules: a Completed or Cancelled batch is frozen, no admin override.
export const DELETE = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage");
  const { id } = await ctx.params;
  await assertResultInScope(user, id); // Rule 38

  const row = await CandidateResult.findById(id);
  if (!row) throw new HttpError(404, "Result not found");
  if (!row.certificate_file) throw new HttpError(404, "There is no certificate file on this row.");

  const batch = await Batch.findById(row.batch).select("status").lean<any>();
  if (["Completed", "Cancelled"].includes(batch?.status)) {
    throw new HttpError(409, "The batch is closed — the certificate file is frozen (2026-08-13 decision: a Completed batch stays locked).");
  }

  const body = await req.json().catch(() => ({}));
  const reason = String(body.reason ?? "").trim();
  if (!reason) throw new HttpError(400, "Say why this certificate file is being removed — it is audited evidence.");

  const was = String(row.certificate_file);
  const r = await removeStoredFile(was, user.id);
  if (!r.removed) throw new HttpError(502, `Storage refused to delete the certificate object: ${r.reason ?? "unknown"}`);
  row.set("certificate_file", undefined);
  await row.save({ validateModifiedOnly: true });
  await audit({
    entity: "CandidateResult", entityId: row._id, field: "certificate_file_removed",
    oldValue: was, newValue: `removed by ${user.name} (${r.backend}) — ${reason}`, actor: user.id,
  });
  return NextResponse.json({ ok: true, backend: r.backend, certificate_status: row.certificate_status });
});
