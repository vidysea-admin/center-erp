import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Location, WorkbookChange, WorkbookSnapshot } from "@/models";
import { audit } from "@/lib/audit";

// 2026-08-11 (CEO): a new row in the client's sheet must NOT auto-enter the main DB —
// it sits pending, a human validates it, edits what needs editing, and only then it is
// added. GET returns the row's cells + a suggested Location prefill; POST creates the
// Location with the human's (possibly edited) values and marks the row's changes Accepted.

const CELL_MAP: [string, string][] = [
  ["Institution Name", "name"],
  ["District", "city"],
  ["State", "state"],
  ["SPOC Name", "spoc_name"],
  ["Cluster Head Contact No.", "spoc_phone"],
  ["TC ID", "external_id"],
];

async function loadRow(id: string) {
  const change = await WorkbookChange.findById(id).lean<any>();
  if (!change) throw new HttpError(404, "Change not found");
  const snap = await WorkbookSnapshot.findOne({ sync_source: change.sync_source, tab: change.tab })
    .sort({ taken_at: -1 }).lean<any>();
  const row = (snap?.rows as any[])?.find((r) => r.key === change.row_key);
  return { change, cells: row?.cells ?? {} };
}

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.approve");
  const { id } = await ctx.params;
  const { change, cells } = await loadRow(id);
  const suggested: Record<string, string> = {};
  for (const [col, field] of CELL_MAP) {
    if (cells[col] && !suggested[field]) suggested[field] = String(cells[col]);
  }
  if (!suggested.name) suggested.name = change.row_key.replace(/ \(#\d+\)$/, "").split(" · ")[0];
  suggested.code = (suggested.external_id || suggested.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)).toUpperCase();
  // Already in the ERP? Then this is a review, not a create.
  const existing = await Location.findOne({
    $or: [
      ...(suggested.external_id ? [{ external_id: suggested.external_id }] : []),
      { name: suggested.name },
    ],
  }).select("name code").lean<any>();
  return NextResponse.json({ suggested, cells, existing });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.approve");
  requireEdit(user);
  const { id } = await ctx.params;
  const { change } = await loadRow(id);
  const body = await req.json();
  const name = String(body.name ?? "").trim();
  const code = String(body.code ?? "").trim();
  if (!name || !code) throw new HttpError(400, "name and code are required");

  const doc = await Location.create({
    code, name,
    city: body.city || undefined, state: body.state || undefined, address: body.address || undefined,
    external_id: body.external_id || undefined,
    spoc_name: body.spoc_name || undefined, spoc_phone: body.spoc_phone || undefined,
    approval_status: body.approval_status === "Approved" ? "Approved" : "Pending",
    operational_status: "Not Started",
  });
  await audit({ entity: "Location", entityId: doc._id, field: "create", newValue: `validated from sheet row "${change.row_key}" by human review`, actor: user.id, actorType: "EXTERNAL_SYNC" });

  // The whole row is now handled — accept every open change that belongs to it.
  await WorkbookChange.updateMany(
    { sync_source: change.sync_source, tab: change.tab, row_key: change.row_key, status: { $in: ["New", "Seen"] } },
    { $set: { status: "Accepted", actor: user.id, actioned_at: new Date() } },
  );
  return NextResponse.json({ item: doc }, { status: 201 });
});
