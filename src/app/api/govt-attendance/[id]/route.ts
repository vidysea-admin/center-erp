import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { GovtAttendanceImport, GovtAttendanceRow } from "@/models";
import { audit } from "@/lib/audit";

async function loadInScope(id: string, user: Awaited<ReturnType<typeof requireUser>>) {
  const imp = await GovtAttendanceImport.findById(id)
    .populate("location", "name external_id").populate("batch", "code")
    .populate("imported_by", "name").lean<any>();
  if (!imp) throw new HttpError(404, "Import not found");
  if (isScoped(user) && imp.location && !(user.location_scope ?? []).map(String).includes(String(imp.location._id))) {
    throw new HttpError(403, "That import belongs to a centre outside your assigned locations.");
  }
  return imp;
}

export const GET = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "attendance.govt");
  const { id } = await ctx.params;
  const imp = await loadInScope(id, user);
  // QA-023 (checker): every count on the summary is a question — each one answers as
  // its own filter. matched | ambiguous | unmatched | variance.
  const filter = req.nextUrl.searchParams.get("filter");
  const q: Record<string, unknown> = { import: id };
  if (filter === "variance") q.variance_days = { $nin: [0, null] };
  if (filter === "unmatched") q.match_status = { $in: ["Unmatched", "Ambiguous"] };
  if (filter === "matched") q.match_status = "Matched";
  if (filter === "ambiguous") q.match_status = "Ambiguous";
  const rows = await GovtAttendanceRow.find(q)
    .populate("candidate", "name phone").populate("trainer", "name").populate("batch", "code")
    .sort({ sl_no: 1 }).lean<any[]>();
  return NextResponse.json({ item: imp, rows });
});

// An import is a point-in-time record of what the portal said, so it is deletable (a wrong file,
// a wrong centre) but never editable — correcting it means importing the corrected export.
export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "attendance.govt");
  const { id } = await ctx.params;
  const imp = await loadInScope(id, user);
  await GovtAttendanceRow.deleteMany({ import: id });
  await GovtAttendanceImport.deleteOne({ _id: id });
  await audit({ entity: "GovtAttendanceImport", entityId: id, field: "delete", oldValue: `${imp.file_name} (${imp.row_count} rows)`, newValue: "", actor: user.id });
  return NextResponse.json({ ok: true });
});
