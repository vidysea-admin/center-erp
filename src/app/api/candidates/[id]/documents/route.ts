import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate, CandidateDocument, CANDIDATE_DOC_TYPE } from "@/models";
import { audit } from "@/lib/audit";
import { removeStoredFile } from "@/lib/storage";

// QA-105 (15/08): the candidate document store — full mirror of the trainer pattern.
// One row per document; re-uploading a type replaces it; Rule 38 scope comes from the
// candidate's own location (fail closed for scoped users on a location-less candidate,
// same stance as crud.ts).

async function loadCandidateInScope(user: Awaited<ReturnType<typeof requireUser>>, id: string) {
  const cand = await Candidate.findById(id).select("location name").lean<any>();
  if (!cand) throw new HttpError(404, "Candidate not found");
  assertLocationInScope(user, String(cand.location ?? "")); // fail closed on no-location for scoped users
  return cand;
}

// GET — every document on file for this candidate.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "candidates.manage");
  const { id } = await ctx.params;
  await loadCandidateInScope(user, id);
  const items = await CandidateDocument.find({ candidate: id }).sort({ createdAt: -1 }).populate("uploaded_by", "name").lean();
  return NextResponse.json({ items });
});

// POST { doc_type, file_url, original_name?, note? } — attach; upload the file first via /api/upload.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.manage");
  const { id } = await ctx.params;
  await loadCandidateInScope(user, id);
  const body = await req.json();
  if (!body.doc_type || !CANDIDATE_DOC_TYPE.includes(body.doc_type)) {
    throw new HttpError(400, `doc_type must be one of: ${CANDIDATE_DOC_TYPE.join(", ")}`);
  }
  if (!body.file_url) throw new HttpError(400, "file_url is required — upload the file first.");
  // Re-uploading a type replaces the previous one rather than stacking duplicates.
  // -101: the replaced row was deleted but its stored OBJECT was left behind — still `ready`,
  // still readable by anyone with the link, and now referenced by nothing, so it never appeared
  // in any list a person would think to check. Replace means the old file leaves storage too.
  const superseded = await CandidateDocument.find({ candidate: id, doc_type: body.doc_type }).select("file_url").lean<any[]>();
  await CandidateDocument.deleteMany({ candidate: id, doc_type: body.doc_type });
  for (const prev of superseded) {
    if (prev.file_url && String(prev.file_url) !== String(body.file_url)) await removeStoredFile(String(prev.file_url), user.id);
  }
  const doc = await CandidateDocument.create({
    candidate: id, doc_type: body.doc_type, file_url: body.file_url,
    original_name: body.original_name, note: body.note, uploaded_by: user.id,
  });
  await audit({ entity: "Candidate", entityId: id, field: "document", newValue: body.doc_type, actor: user.id });
  return NextResponse.json({ item: doc }, { status: 201 });
});
