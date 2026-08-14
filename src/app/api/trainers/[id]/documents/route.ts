import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Trainer, TrainerDocument, TRAINER_DOC_TYPE } from "@/models";
import { assertTrainerInScope, trainerDocSummary } from "@/lib/rules";
import { audit } from "@/lib/audit";

// 2026-08-12 (Manish): "phir uske documents mangaye - Aadhaar, PAN, photo, CV, educational
// qualification, CIPSA certificate". One row per document so each can be re-uploaded or verified
// independently, and so the audit trail is per-document rather than one opaque blob.

// GET — every document on file, plus what is still missing for a nomination.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "trainers.manage");
  const { id } = await ctx.params;
  await assertTrainerInScope(user, id); // QA-125: Aadhaar/PAN are personnel data — scope, not just the right
  const [items, summary] = await Promise.all([
    TrainerDocument.find({ trainer: id }).sort({ createdAt: -1 }).populate("uploaded_by", "name").populate("verified_by", "name").lean(),
    trainerDocSummary(id),
  ]);
  return NextResponse.json({ items, summary });
});

// POST { doc_type, file_url, original_name?, note? } — attach a document. The file itself is
// uploaded first via /api/upload, which returns the url; this records what that file IS.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "trainers.manage");
  const { id } = await ctx.params;
  if (!(await Trainer.exists({ _id: id }))) throw new HttpError(404, "Trainer not found");
  await assertTrainerInScope(user, id); // QA-125: writing a file onto a foreign trainer was live-proved

  const body = await req.json();
  if (!body.doc_type || !TRAINER_DOC_TYPE.includes(body.doc_type)) {
    throw new HttpError(400, `doc_type must be one of: ${TRAINER_DOC_TYPE.join(", ")}`);
  }
  if (!body.file_url) throw new HttpError(400, "file_url is required — upload the file first.");

  // Re-uploading a document type replaces the previous one rather than stacking duplicates,
  // which is what actually happens when NSDC bounces a profile and a corrected copy comes back.
  await TrainerDocument.deleteMany({ trainer: id, doc_type: body.doc_type });
  const doc = await TrainerDocument.create({
    trainer: id,
    doc_type: body.doc_type,
    file_url: body.file_url,
    original_name: body.original_name,
    note: body.note,
    uploaded_by: user.id,
  });
  await audit({ entity: "Trainer", entityId: id, field: "document", newValue: body.doc_type, actor: user.id });
  return NextResponse.json({ item: doc, summary: await trainerDocSummary(id) }, { status: 201 });
});
