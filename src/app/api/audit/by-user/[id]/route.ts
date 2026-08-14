import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { AuditLog } from "@/models";

// QA-137 (Umesh, 15/08: "poora per-user activity view" — "Divya ne aaj kya kiya" ka jawab).
// Admin-only ON PURPOSE, v1: a person's trail spans every centre, so handing it to a scoped
// role would be a back door around Rule 38 — the exact list-hides/item-allows pattern
// QA-095/QA-125 closed seven times. The checker flagged the same risk; widen only with a
// deliberate design, not by default. Read-only; ?entity= narrows; page/limit paginate.
export const GET = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  if (user.role !== "Admin") throw new HttpError(403, "Only an Admin may read a person's full activity trail.");
  const { id } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = { actor: id };
  const entity = sp.get("entity");
  if (entity) filter.entity = entity;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
  const asked = Number(sp.get("limit") ?? "");
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(500, Math.ceil(asked)) : 100;
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit)
      .populate("actor", "name email").lean(),
    AuditLog.countDocuments(filter),
  ]);
  return NextResponse.json({ items, total, page, limit });
});
