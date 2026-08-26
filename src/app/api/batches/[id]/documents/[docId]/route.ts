import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BatchDocument } from "@/models";
import { assertBatchInScope, batchDocSummary } from "@/lib/rules";
import { audit } from "@/lib/audit";
import { removeStoredFile } from "@/lib/storage";

// 2026-08-26 — a wrong file has to be removable, same right that attaches it
// (batches.daily_log + edit + batch scope). Mirrors trainers/[id]/documents/[docId]/route.ts.
// The stored object leaves WITH the record so its URL answers 410 from now on.

export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string; docId: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.daily_log");
  const { id, docId } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38

  const doc = await BatchDocument.findOne({ _id: docId, batch: id });
  if (!doc) throw new HttpError(404, "Document not found on this batch.");

  await doc.deleteOne();
  await removeStoredFile(String(doc.file_url ?? ""), user.id).catch(() => null);
  await audit({
    entity: "Batch", entityId: id, field: "document_deleted",
    oldValue: `${doc.doc_type}${doc.original_name ? ` (${doc.original_name})` : ""}`,
    newValue: `removed by ${user.name}`,
    actor: user.id,
  });
  return NextResponse.json({ ok: true, summary: await batchDocSummary(id) });
});
