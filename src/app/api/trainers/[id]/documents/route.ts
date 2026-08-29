import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { Trainer, TrainerDocument, TRAINER_DOC_TYPE } from "@/models";
import { trainerDocSummary, trainerDocsAccess } from "@/lib/rules";
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
  const { id } = await ctx.params;
  // QA-1575: `trainers.manage` as before, OR a Trainer login reading its OWN record. The helper
  // still runs QA-125's scope check on the manage path — that check was never about the right.
  await trainerDocsAccess(user, id);
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
  const { id } = await ctx.params;
  if (!(await Trainer.exists({ _id: id }))) throw new HttpError(404, "Trainer not found");
  // QA-1575: writing a file onto a FOREIGN trainer was live-proved once (QA-125) and this must not
  // reopen it. `trainerDocsAccess` grants "self" only when trainerForLogin() resolves to THIS id.
  const access = await trainerDocsAccess(user, id);

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
  const superseded = await TrainerDocument.find({ trainer: id, doc_type: body.doc_type }).select("file_url verified").lean<any[]>();
  // QA-1575: uploading REPLACES the same doc_type (see the note above) — which means the new
  // self-serve path could otherwise let a trainer quietly overwrite a document an Admin had already
  // verified, taking the verification with it. Umesh's decision was that a trainer may FILE their
  // own documents ("daal sake"), not that they may undo somebody else's verification. So a trainer
  // replacing their own VERIFIED document is refused and told who to ask; an operator with
  // `trainers.manage` keeps today's behaviour untouched.
  if (access === "self" && superseded.some((d) => d.verified)) {
    throw new HttpError(409, `Your ${body.doc_type} has already been verified, so it cannot be replaced here. Ask an Admin if it needs to change.`);
  }
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
