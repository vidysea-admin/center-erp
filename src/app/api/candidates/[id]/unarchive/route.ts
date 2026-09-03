import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate } from "@/models";
import { unarchiveCandidate } from "@/lib/candidate-archive";

// candidates-bulk-archive-restore-ux: undo an archive. Same right as archiving
// (candidates.delete) — restoring is the same class of action, not a lesser one.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.delete");
  const { id } = await ctx.params;
  const c = await Candidate.findById(id);
  if (!c) throw new HttpError(404, "Candidate not found");
  if (isScoped(user)) {
    const locId = (c as any).location;
    if (!locId || !user.location_scope.map(String).includes(String(locId))) {
      throw new HttpError(403, "Out of scope");
    }
  }
  await unarchiveCandidate(c, user);
  return NextResponse.json({ ok: true, archived: false });
});
