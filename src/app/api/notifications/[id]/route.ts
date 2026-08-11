import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { Notification } from "@/models";
import { audit } from "@/lib/audit";

// Acknowledge or resolve an alert. Acknowledging is explicitly allowed for view-only users
// (it records that someone saw it) but resolving is not.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  const { status } = await req.json();
  if (!["Acknowledged", "Resolved"].includes(status)) throw new HttpError(400, "status must be Acknowledged or Resolved");
  if (status === "Resolved" && !["Admin", "Operations"].includes(user.role) && !user.can_edit) {
    throw new HttpError(403, "Read-only access");
  }

  const n = await Notification.findById(id);
  if (!n) throw new HttpError(404, "Notification not found");
  if (!n.role_target.includes(user.role as any)) throw new HttpError(403, "Not addressed to your role");

  n.status = status;
  n.acknowledged_by = user.id as any;
  n.acknowledged_at = new Date();
  await n.save();
  await audit({ entity: "Notification", entityId: n._id, field: "status", newValue: status, actor: user.id });
  return NextResponse.json({ item: n });
});
