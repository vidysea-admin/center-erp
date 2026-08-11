import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { MeetingNote } from "@/models";
import { audit } from "@/lib/audit";

// Meeting notes per location (2026-08-11 meeting): who was spoken to, when, what was said —
// so Admin and Ops stay on the same page about every location conversation.

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  assertLocationInScope(user, id);
  const items = await MeetingNote.find({ location: id })
    .sort({ meeting_date: -1 }).limit(200)
    .populate("logged_by", "name")
    .lean<any[]>();
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  assertLocationInScope(user, id);
  const body = await req.json();
  const note = String(body.note ?? "").trim();
  if (!note) throw new HttpError(400, "Note text is required.");
  const doc = await MeetingNote.create({
    location: id,
    meeting_date: body.meeting_date ? new Date(body.meeting_date) : new Date(),
    met_with: String(body.met_with ?? "").trim(),
    note,
    logged_by: user.id,
  });
  await audit({ entity: "MeetingNote", entityId: doc._id, field: "create", newValue: `${doc.met_with || "—"}: ${note.slice(0, 120)}`, actor: user.id });
  return NextResponse.json({ item: doc }, { status: 201 });
});
