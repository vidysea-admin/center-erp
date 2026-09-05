import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError, readJson } from "@/lib/authz";
import { CostCategory, DropReason, FailureReason, JobRole, Scheme } from "@/models";
import { audit } from "@/lib/audit";
import { coerceExtras, assertMayWriteCategoryMoney } from "../route";
import { hasPermission, FINANCE_VIEW, maskCostCategoryMoney } from "@/lib/permissions";

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
  const body = await readJson(req);
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
  // QA-1828: the head/subhead fields go through the SAME coercion the create door uses, imported
  // rather than restated. This route already carried a second copy of the create door's field
  // handling (`FIELDS` beside `EXTRA_FIELDS`, `NUMERIC` beside its numeric check) and the two had
  // already drifted — schemes are editable here and job-role codes are not. Adding eight more
  // fields to a second copy is how the next drift happens.
  if (list === "cost-categories") {
    await assertMayWriteCategoryMoney(user, list, body);
    const extras = await coerceExtras(list, body);
    // Two refusals that only make sense against the document being edited, so they live here and
    // not in the shared coercion: a category cannot be its own parent (a cycle that hangs any walk
    // of the tree), and a head that already HAS subheads cannot become one (a three-level chain by
    // the back door — the create-time check can only see the parent, never the children).
    if (extras.parent && String(extras.parent) === String(doc._id)) {
      throw new HttpError(400, "A cost head cannot be its own parent.");
    }
    if (extras.parent) {
      const children = await CostCategory.countDocuments({ parent: doc._id });
      if (children > 0) {
        throw new HttpError(400, `"${doc.name}" has ${children} subhead(s) — move or retire those first, or it would become a third level.`);
      }
    }
    for (const [k, v] of Object.entries(extras)) (doc as any)[k] = v;
  }
  await doc.save();
  await audit({ entity: "MasterList", entityId: doc._id, field: list, newValue: `updated ${doc.name}`, actor: user.id });
  // The response is the row that was just written, so it carries the money the request may have
  // set. Masked on the way out like every other read of this list — an Admin without the grant can
  // edit a description here and must not learn the budget from the reply.
  // Only this list has money on it; every other master returns exactly what it always did.
  const item = list === "cost-categories"
    ? maskCostCategoryMoney(doc.toObject(), await hasPermission(user, FINANCE_VIEW))
    : doc;
  return NextResponse.json({ item });
});
