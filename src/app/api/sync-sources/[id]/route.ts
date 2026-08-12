import { NextRequest, NextResponse } from "next/server";
import { itemRoutes } from "@/lib/crud";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { SheetChange, SyncSource, WorkbookChange, WorkbookSnapshot } from "@/models";
import { audit } from "@/lib/audit";

export const { GET, PATCH } = itemRoutes({
  model: SyncSource, entity: "SyncSource", scopeField: null,
  fields: ["name", "source_url", "sync_time", "frequency", "field_mappings", "mode", "interval_minutes", "key_columns", "active"],
  writeRoles: ["Admin"],
  permission: "sheet.sources", // 2026-08-11 togglable right (writeRoles = fallback only)
  readPermission: "sheet.sources", // read follows the same togglable right as write (Rule 40 baseline)
});

// 2026-08-12: a sheet added by mistake, or one the client has retired, has to be removable —
// otherwise the poller keeps failing against a dead URL forever. The snapshots and detected
// changes go with it, because a change history that points at a source nobody can open is
// noise. Pending SheetChanges are NOT deleted: they may already have been acted on, and the
// audit trail is the point of them.
export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "sheet.sources");
  const { id } = await ctx.params;
  const src = await SyncSource.findById(id).lean<any>();
  if (!src) throw new HttpError(404, "Sync source not found");

  const openChanges = await SheetChange.countDocuments({ sync_source: id, status: "Open" });
  if (openChanges) {
    throw new HttpError(409, `${openChanges} change(s) from this sheet are still waiting in the Sync Inbox. Accept or reject them first — deleting the source would lose what they were proposing.`);
  }
  const snaps = await WorkbookSnapshot.deleteMany({ sync_source: id });
  const changes = await WorkbookChange.deleteMany({ sync_source: id });
  await SyncSource.deleteOne({ _id: id });
  await audit({
    entity: "SyncSource", entityId: id, field: "delete",
    oldValue: `${src.name} (${src.source_url})`,
    newValue: `removed with ${snaps.deletedCount} snapshot(s) and ${changes.deletedCount} tracked change(s)`,
    actor: user.id,
  });
  return NextResponse.json({ ok: true, snapshots_removed: snaps.deletedCount, changes_removed: changes.deletedCount });
});
