import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Location } from "@/models";
import { locationUsage } from "@/lib/rules";

// qa-location-delete-warn-impact (Umesh, 2026-09-22, qa/gates/location-delete-behaviour.md): the
// companion GET behind the delete confirmation Drawer, exactly like programs/[id]/usage/route.ts.
// The delete (../route.ts DELETE) stays unconditional Option-B; this endpoint adds NO block. It
// exists so the confirmation Drawer can NAME the blast radius (which batches, and a count of every
// other referencing record) before the typed confirm, instead of a blind "are you sure". Gated at
// the SAME right as the Delete action itself (`locations.delete`) — a caller who could not press
// Delete should not be able to learn how many candidates/trainers sit under a centre.
export const GET = apiHandler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "locations.delete");
  const { id } = await ctx.params;
  const location = await Location.findById(id).select("code name").lean<any>();
  if (!location) throw new HttpError(404, "Location not found");
  const usage = await locationUsage(id);
  return NextResponse.json({ code: location.code, name: location.name, ...usage });
});
