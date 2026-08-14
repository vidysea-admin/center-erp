import { NextRequest, NextResponse } from "next/server";
import { unlink } from "fs/promises";
import path from "path";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { TrainerDocument } from "@/models";
import { assertTrainerInScope, trainerDocSummary } from "@/lib/rules";
import { audit } from "@/lib/audit";

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
  await assertTrainerInScope(user, id); // QA-125: deleting a foreign trainer's Aadhaar was live-proved

  const doc = await TrainerDocument.findOne({ _id: docId, trainer: id });
  if (!doc) throw new HttpError(404, "Document not found on this trainer.");

  await doc.deleteOne();
  // Best-effort disk cleanup — the DB row is the record; a stray file is only disk space.
  const name = String(doc.file_url ?? "").split("/").pop();
  if (name && /^[a-f0-9]{32}\.[a-z0-9]+$/i.test(name)) {
    await unlink(path.join(process.cwd(), "uploads", name)).catch(() => {});
  }
  await audit({
    entity: "Trainer", entityId: id, field: "document_deleted",
    oldValue: `${doc.doc_type}${doc.original_name ? ` (${doc.original_name})` : ""}`,
    newValue: `removed by ${user.name}`,
    actor: user.id,
  });
  return NextResponse.json({ ok: true, summary: await trainerDocSummary(id) });
});
