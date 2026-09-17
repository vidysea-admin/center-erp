import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError, readJson } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate } from "@/models";
import { purgeBlockers, purgeCandidate } from "@/lib/candidate-archive";

// Sub-unit D (qa-candidates-purge, spec qa/specs/manish-delete-surfaces.md sections 3 + 9): the
// permanent delete of an ARCHIVED, provably empty candidate. A SEPARATE endpoint from the archive
// DELETE on /api/candidates/[id] by design - that door must keep meaning "archive" and nothing else.
//
// Order of refusals: right -> exists -> Rule 38 scope -> (POST) reason, typed name -> preconditions.
// Scope comes before any precondition message for the QA-1008 reason: "this person has documents"
// is itself a disclosure about a record the caller may not be allowed to see.
async function load(ctx: { params: Promise<{ id: string }> }) {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.purge");
  const { id } = await ctx.params;
  const c = await Candidate.findById(id);
  if (!c) throw new HttpError(404, "Candidate not found");
  if (isScoped(user)) {
    const locId = (c as any).location;
    if (!locId || !user.location_scope.map(String).includes(String(locId))) {
      throw new HttpError(403, "Out of scope");
    }
  }
  return { user, c };
}

// GET - what would block a purge right now. Read-only; the Drawer shows these before anyone types.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { c } = await load(ctx);
  const blockers = await purgeBlockers(c);
  return NextResponse.json({ name: c.name, blockers });
});

// POST { reason, confirm_name } - permanently delete. Immediate, no recovery window (Umesh, section 9).
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { user, c } = await load(ctx);
  const body = ((await readJson(req).catch(() => ({}))) as any) ?? {};
  const out = await purgeCandidate(c, user, { reason: body.reason, confirmName: body.confirm_name });
  return NextResponse.json({ ok: true, ...out });
});
