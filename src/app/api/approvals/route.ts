import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, isScoped, locationFilter } from "@/lib/authz";
import { ApprovalRequest, ApprovalRule } from "@/models";
import { APPROVAL_ACTIONS } from "@/models";
import { audit } from "@/lib/audit";

// GET — pending/decided requests plus the current rule configuration.
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  const status = req.nextUrl.searchParams.get("status") ?? "Pending";
  const filter: Record<string, unknown> = status === "all" ? {} : { status };
  if (isScoped(user)) Object.assign(filter, locationFilter(user));

  const [items, rules] = await Promise.all([
    ApprovalRequest.find(filter).sort({ createdAt: -1 }).limit(100)
      .populate("initiator", "name").populate("decided_by", "name").populate("location", "name code").lean(),
    ApprovalRule.find({}).lean(),
  ]);
  // Actions with no stored rule are simply off.
  const config = APPROVAL_ACTIONS.map((action) => {
    const r = rules.find((x: any) => x.action === action);
    return { action, enabled: !!r?.enabled, approver_role: r?.approver_role ?? "Admin" };
  });
  return NextResponse.json({ items, config });
});

// PUT — Admin toggles which actions require approval (RPL M24, configurable by design).
export const PUT = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin");
  const { action, enabled, approver_role } = await req.json();
  if (!APPROVAL_ACTIONS.includes(action)) throw new Error("Unknown approval action: " + action);
  const rule = await ApprovalRule.findOneAndUpdate(
    { action },
    { $set: { enabled: !!enabled, ...(approver_role ? { approver_role } : {}) } },
    { upsert: true, new: true },
  );
  await audit({ entity: "ApprovalRule", entityId: rule._id, field: action, newValue: { enabled: !!enabled, approver_role }, actor: user.id });
  return NextResponse.json({ item: rule });
});
