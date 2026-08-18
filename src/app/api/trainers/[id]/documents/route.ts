import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Trainer, TrainerDocument, TRAINER_DOC_TYPE } from "@/models";
import { assertTrainerInScope, trainerDocSummary } from "@/lib/rules";
import { audit } from "@/lib/audit";
import { removeStoredFile } from "@/lib/storage";

// 2026-08-12 (Manish): "phir uske documents mangaye - Aadhaar, PAN, photo, CV, educational
// qualification, CIPSA certificate" — his words; -129 (QA-268) corrected the stored value to CITS
// Certificate, which is the real credential. One row per document so each can be re-uploaded or verified
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
  // -101: same orphan as the candidate side — the superseded row went, its stored object stayed
  // readable and unreferenced. A corrected copy replacing a bounced one should not leave the
  // bounced scan in the bucket.
  const superseded = await TrainerDocument.find({ trainer: id, doc_type: body.doc_type }).select("file_url").lean<any[]>();
  await TrainerDocument.deleteMany({ trainer: id, doc_type: body.doc_type });
  for (const prev of superseded) {
    if (prev.file_url && String(prev.file_url) !== String(body.file_url)) await removeStoredFile(String(prev.file_url), user.id);
  }
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
