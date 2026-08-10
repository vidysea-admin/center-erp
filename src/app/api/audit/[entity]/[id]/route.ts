import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { AuditLog } from "@/models";

// Activity feed for any entity (read-only)
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ entity: string; id: string }> }) => {
  await dbConnect();
  await requireUser();
  const { entity, id } = await ctx.params;
  const items = await AuditLog.find({ entity, entity_id: id }).sort({ created_at: -1 }).limit(200).populate("actor", "name").lean();
  return NextResponse.json({ items });
});
