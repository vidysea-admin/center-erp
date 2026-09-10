import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, isScoped, locationFilter, readJson } from "@/lib/authz";
import { requirePerm, requireView, hasPermission, maskApprovalMoney, FINANCE_VIEW } from "@/lib/permissions";
import { ApprovalRequest, ApprovalRule } from "@/models";
import { APPROVAL_ACTIONS } from "@/models";
import { audit } from "@/lib/audit";
import { flushPendingFinanceAuditEvents } from "@/lib/approvals";

// GET — pending/decided requests plus the current rule configuration.
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await flushPendingFinanceAuditEvents().catch(() => {});
  // R-E: ?mine=1 — the initiator's own submissions only (CEO: once approved "it should go
  // from their queue and then they're done"; a rejection shows its note so they can fix and
  // repost). No approvals.decide needed: these are the caller's own requests, nobody else's.
  if (req.nextUrl.searchParams.get("mine") === "1") {
    const mineItems = await ApprovalRequest.find({ initiator: user.id })
      .sort({ createdAt: -1 }).limit(100)
      .populate("decided_by", "name").populate("location", "name code").lean();
    const canSeeMoney = await hasPermission(user, FINANCE_VIEW);
    const items = mineItems.map((raw: any) => {
      if (canSeeMoney) return raw;
      // The raiser is entitled to the amount they themselves submitted, but not to a later
      // sanctioned amount or to money repeated in summaries / decision prose. Reuse the one
      // approval masker, then put back only that single requester-owned fact at its canonical
      // payload location. Keeping decision_note out entirely also prevents a new prose field from
      // becoming a second finance door.
      const masked: any = maskApprovalMoney(raw, canSeeMoney);
      delete masked.decision_note;
      if (raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          && raw.payload.amount !== undefined) {
        masked.payload = { ...(masked.payload ?? {}), amount: raw.payload.amount };
      }
      return masked;
    });
    return NextResponse.json({ items });
  }
  // 2026-08-12 audit (auth S3-5): requireUser() alone. Each request carries the replay
  // `payload` — closure reasons, invoice amounts — so any signed-in user could read what the
  // business was about to do and why. Deciding an approval is already gated; seeing the queue
  // now is too. QA-025 P2: seeing = view level; deciding (POST/decide paths) keeps edit.
  await requireView(user, "approvals.decide");
  const status = req.nextUrl.searchParams.get("status") ?? "Pending";
  // Applying is a recoverable in-flight finance claim, not a completed decision. Keep it in the
  // default approver queue so a process restart cannot turn durable work into an invisible orphan.
  const filter: Record<string, unknown> = status === "all" ? {}
    : status === "Pending" ? { status: { $in: ["Pending", "Applying"] } }
      : { status };
  if (isScoped(user)) Object.assign(filter, locationFilter(user));

  const [items, rules] = await Promise.all([
    ApprovalRequest.find(filter).sort({ createdAt: -1 }).limit(100)
      .populate("initiator", "name").populate("decided_by", "name").populate("location", "name code").lean(),
    ApprovalRule.find({}).lean(),
  ]);
  // Actions with no stored rule are simply off.
  const config = APPROVAL_ACTIONS.map((action) => {
    const r = rules.find((x: any) => x.action === action);
    return {
      action, enabled: !!r?.enabled, approver_role: r?.approver_role ?? "Admin",
      approver_users: (r?.approver_users ?? []).map(String), // QA-1827
    };
  });
  // QA-1843: a parked cost carries its figure twice — `payload.amount` and the ₹ interpolated into
  // `summary`. Masked here rather than refused, for the same reason as Home and the closure tab:
  // whoever holds `approvals.decide` needs to SEE the queue to work it. Note the `?mine=1` branch
  // above preserves only the requester's own payload.amount; sanction figures and their prose
  // echoes are finance facts and stay masked.
  const canSeeMoney = await hasPermission(user, FINANCE_VIEW);
  return NextResponse.json({ items: items.map((r: any) => maskApprovalMoney(r, canSeeMoney)), config });
});

// PUT — Admin toggles which actions require approval (RPL M24, configurable by design).
export const PUT = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin");
  const { action, enabled, approver_role, approver_users } = await readJson(req);
  if (!APPROVAL_ACTIONS.includes(action)) throw new Error("Unknown approval action: " + action);
  // QA-1827: the named list. `undefined` leaves it alone (so an existing caller that only toggles
  // `enabled` cannot silently clear it); an explicit `[]` clears it back to role-only, which is how
  // the setting is switched off.
  const named = approver_users === undefined ? undefined : (Array.isArray(approver_users) ? approver_users.filter(Boolean) : []);
  const rule = await ApprovalRule.findOneAndUpdate(
    { action },
    { $set: { enabled: !!enabled, ...(approver_role ? { approver_role } : {}), ...(named === undefined ? {} : { approver_users: named }) } },
    { upsert: true, new: true },
  );
  await audit({ entity: "ApprovalRule", entityId: rule._id, field: action, newValue: { enabled: !!enabled, approver_role, ...(named === undefined ? {} : { approver_users: named }) }, actor: user.id });
  return NextResponse.json({ item: rule });
});
