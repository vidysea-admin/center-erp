import { NextRequest, NextResponse } from "next/server";
import { unlink } from "fs/promises";
import path from "path";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate, CandidateDocument } from "@/models";
import { audit } from "@/lib/audit";

// QA-105 + QA-112's lesson applied from day one: a wrong candidate document is removable,
// audited (what left, who removed it), and replace = delete + upload again.
export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string; docId: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.manage");
  const { id, docId } = await ctx.params;
  const cand = await Candidate.findById(id).select("location").lean<any>();
  if (!cand) throw new HttpError(404, "Candidate not found");
  assertLocationInScope(user, String(cand.location ?? ""));
  const doc = await CandidateDocument.findOne({ _id: docId, candidate: id });
  if (!doc) throw new HttpError(404, "Document not found on this candidate.");
  await doc.deleteOne();
  const name = String(doc.file_url ?? "").split("/").pop();
  if (name && /^[a-f0-9]{32}\.[a-z0-9]+$/i.test(name)) {
    await unlink(path.join(process.cwd(), "uploads", name)).catch(() => {});
  }
  await audit({
    entity: "Candidate", entityId: id, field: "document_deleted",
    oldValue: `${doc.doc_type}${doc.original_name ? ` (${doc.original_name})` : ""}`,
    newValue: `removed by ${user.name}`, actor: user.id,
  });
  return NextResponse.json({ ok: true });
});
