import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { TrainerDocument } from "@/models";
import { assertTrainerDocDeleteInScope, trainerDocSummary } from "@/lib/rules";
import { audit } from "@/lib/audit";
import { removeStoredFile } from "@/lib/storage";

// QA-112 (checker, 15/08): a wrong file on a trainer was PERMANENT — no delete, no
// replace. These are Aadhaar/PAN-grade documents; a mis-attached file has to be removable
// by the people who manage trainers. Replace = delete + upload again (the drawer says so).
// The audit row names what left and who removed it, so the history survives the file.

export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string; docId: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "trainers.manage");
  const { id, docId } = await ctx.params;
  // QA-125: deleting a foreign trainer's Aadhaar was live-proved. Delete is narrower than
  // read/upload — ownership (nominating/home centre), not the teaching union.
  await assertTrainerDocDeleteInScope(user, id);

  const doc = await TrainerDocument.findOne({ _id: docId, trainer: id });
  if (!doc) throw new HttpError(404, "Document not found on this trainer.");

  await doc.deleteOne();
  // -97: the stored object leaves WITH the record (bucket / Drive / local) and its URL answers 410
  // from now on — before this only a local file was unlinked and a bucket object outlived the row.
  await removeStoredFile(String(doc.file_url ?? ""), user.id).catch(() => null);
  await audit({
    entity: "Trainer", entityId: id, field: "document_deleted",
    oldValue: `${doc.doc_type}${doc.original_name ? ` (${doc.original_name})` : ""}`,
    newValue: `removed by ${user.name}`,
    actor: user.id,
  });
  return NextResponse.json({ ok: true, summary: await trainerDocSummary(id) });
});
