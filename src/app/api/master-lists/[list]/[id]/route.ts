import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { CostCategory, DropReason, FailureReason, JobRole, Scheme } from "@/models";
import { audit } from "@/lib/audit";

// QA-118/119 (15/08): masters are EDITABLE, not append-only — the scheme hours arrive
// weeks after the scheme row exists, and a typo'd name must be fixable. Admin-only, like
// creation. No DELETE: a master row someone once used is history — deactivate it instead.
const LISTS: Record<string, any> = {
  "cost-categories": CostCategory, "drop-reasons": DropReason, "failure-reasons": FailureReason,
  "job-roles": JobRole, "schemes": Scheme,
};
const FIELDS: Record<string, string[]> = {
  "cost-categories": ["name", "active"], "drop-reasons": ["name", "active"], "failure-reasons": ["name", "active"],
  "job-roles": ["name", "code", "active"],
  "schemes": ["name", "code", "total_hours", "min_required_hours", "amount_received", "active"],
};
const NUMERIC = new Set(["total_hours", "min_required_hours", "amount_received"]);

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ list: string; id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin"); // Rule 40 — same door as creation
  const { list, id } = await ctx.params;
  const Model = LISTS[list];
  if (!Model) throw new HttpError(404, "Unknown list");
  const doc = await Model.findById(id);
  if (!doc) throw new HttpError(404, "Entry not found");
  const body = await req.json();
  for (const f of FIELDS[list] ?? []) {
    if (body[f] === undefined) continue;
    if (f === "active") { doc.active = !!body[f]; continue; }
    if (NUMERIC.has(f)) {
      if (body[f] === null || body[f] === "") { (doc as any)[f] = undefined; continue; }
      const n = Number(body[f]);
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${f} must be a non-negative number`);
      (doc as any)[f] = n;
      continue;
    }
    const s = String(body[f]).trim();
    if (f === "name" && !s) throw new HttpError(400, "name cannot be blank");
    (doc as any)[f] = s || undefined;
  }
  await doc.save();
  await audit({ entity: "MasterList", entityId: doc._id, field: list, newValue: `updated ${doc.name}`, actor: user.id });
  return NextResponse.json({ item: doc });
});
