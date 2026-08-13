import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { CostEntry } from "@/models";
import { assertCostEntryValid } from "@/lib/rules";
import { audit, auditDiff } from "@/lib/audit";

// Cost entries were write-once (no update/delete route existed) — but sheet-imported costs
// (Batch_Master's four cost columns) can carry a wrong amount or category, so holders of
// costs.manage must be able to correct or remove an entry. Rule 38 applies to by-ID writes.

async function loadInScope(user: Awaited<ReturnType<typeof requireUser>>, id: string) {
  const doc = await CostEntry.findById(id);
  if (!doc) throw new HttpError(404, "Cost entry not found");
  if (isScoped(user)) {
    // Fail closed: an entry with no location is not writable by a scoped user.
    if (!doc.location || !user.location_scope.map(String).includes(String(doc.location))) {
      throw new HttpError(403, "Out of scope");
    }
  }
  return doc;
}

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "costs.manage");
  requireEdit(user);
  const { id } = await ctx.params;
  const doc = await loadInScope(user, id);
  const body = await req.json();
  const patch: Record<string, unknown> = {};
  for (const f of ["entry_date", "location", "batch", "trainer", "category", "amount", "note"]) {
    if (body[f] !== undefined) patch[f] = body[f] === "" ? undefined : body[f];
  }
  const before = doc.toObject();
  assertCostEntryValid({ ...before, ...patch }); // Rule 37 on the merged entry
  Object.assign(doc, patch);
  await doc.save({ validateModifiedOnly: true });
  await auditDiff("CostEntry", doc._id, before, patch, user.id);
  return NextResponse.json({ item: doc });
});

export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "costs.manage");
  requireEdit(user);
  const { id } = await ctx.params;
  const doc = await loadInScope(user, id);
  await doc.deleteOne();
  await audit({ entity: "CostEntry", entityId: doc._id, field: "deleted", oldValue: { amount: doc.amount, note: doc.note }, actor: user.id });
  return NextResponse.json({ ok: true });
});
