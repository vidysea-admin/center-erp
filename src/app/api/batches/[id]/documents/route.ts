import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchDocument, BATCH_DOC_TYPE } from "@/models";
import { assertBatchInScope, batchDocSummary } from "@/lib/rules";
import { audit } from "@/lib/audit";

// 2026-08-26 (RPL compliance): the six batch-level document categories a client's RPL batch must
// have on file — candidate registration forms, assessment-day photos, the final signed
// attendance sheet, post-certification photos. One row per FILE (not per doc_type) — unlike
// TrainerDocument/CandidateDocument, a re-upload here APPENDS rather than replaces, because a
// doc_type routinely needs several files (several registration forms, several angle photos).
// Gated on batches.daily_log — reused deliberately, not a new permission key: it is already the
// Trainer role's one default right and already gates the analogous daily-evidence door
// (batches/[id]/logs/route.ts).

// GET — every document on file for this batch, plus what is still missing.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const [items, summary] = await Promise.all([
    BatchDocument.find({ batch: id }).sort({ createdAt: -1 }).populate("uploaded_by", "name").lean(),
    batchDocSummary(id),
  ]);
  return NextResponse.json({ items, summary });
});

// POST { doc_type, file_url, original_name?, note? } — attach a document. The file itself is
// uploaded first via /api/upload, which returns the url; this records what that file IS.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.daily_log");
  const { id } = await ctx.params;
  if (!(await Batch.exists({ _id: id }))) throw new HttpError(404, "Batch not found");
  await assertBatchInScope(user, id); // Rule 38

  const body = await req.json();
  if (!body.doc_type || !BATCH_DOC_TYPE.includes(body.doc_type)) {
    throw new HttpError(400, `doc_type must be one of: ${BATCH_DOC_TYPE.join(", ")}`);
  }
  if (!body.file_url) throw new HttpError(400, "file_url is required — upload the file first.");

  const doc = await BatchDocument.create({
    batch: id,
    doc_type: body.doc_type,
    file_url: body.file_url,
    original_name: body.original_name,
    note: body.note,
    uploaded_by: user.id,
  });
  await audit({ entity: "Batch", entityId: id, field: "document", newValue: body.doc_type, actor: user.id });
  return NextResponse.json({ item: doc, summary: await batchDocSummary(id) }, { status: 201 });
});
