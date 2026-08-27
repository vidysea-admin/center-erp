import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Program } from "@/models";
import { programUsage } from "@/lib/rules";

// 2026-08-27 (Umesh, verbal, following the 2026-08-25 unconditional-delete decision on
// programs/[id]/route.ts's DELETE): the delete stays unconditional and unguarded — this endpoint
// adds NO block. It exists so admin/page.tsx's confirm() can name real numbers before the click
// instead of a blind "are you sure". Gated at the SAME level as the Delete button itself
// (`can("programs.delete", "edit")` on the page, `programs.delete` here) — a caller who could not
// see the Delete button should not be able to learn how many candidates are in which batches.
export const GET = apiHandler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "programs.delete");
  const { id } = await ctx.params;
  const program = await Program.findById(id).select("code name").lean<any>();
  if (!program) throw new HttpError(404, "Program not found");
  const usage = await programUsage(id);
  return NextResponse.json({ code: program.code, name: program.name, ...usage });
});
