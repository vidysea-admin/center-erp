import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { Batch, Location, PublicToken } from "@/models";
import { assertBatchInScope, planArtifact } from "@/lib/rules";

// QA-152 part 2 (-82): the signed-in plan view. Read for anyone who can see the batch
// (Rule 38 scope is the gate); editing goes through PATCH /api/batches/[id]/milestones.
// Also returns the currently active share link (if any) so the page can show/copy it.
//
// REQ-392 (QA-557): a plan share belongs to a person, so this now answers the two questions the
// product could not answer before - WHO could be sent this plan, and who already HAS it. The
// candidate list is built from the batch's own centre, in the contract's order: the SPOC slot, the
// Principal slot, the cluster head, then every entry in `contacts[]`. No new subsystem and no new
// role: `USER_ROLE` has no SPOC/Principal/Owner and the contract forbids adding them, so the
// audience comes from the centre's contacts exactly as they are typed.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);
  const art = await planArtifact(id);

  const links = await PublicToken.find({ purpose: "plan", batch: id, active: true })
    .select("token allow_updates createdAt recipient_name recipient_phone recipient_role_label recipient_ref")
    .sort({ createdAt: -1 }).lean<any[]>();

  const b = await Batch.findById(id).select("location").lean<any>();
  const loc = b?.location ? await Location.findById(b.location)
    .select("spoc_name spoc_phone principal_name principal_phone cluster_head_name cluster_head_phone contacts").lean<any>() : null;
  const recipients: { ref: string; name: string; phone: string; role_label: string }[] = [];
  const add = (ref: string, name?: string, phone?: string, role_label?: string) => {
    const n = String(name ?? "").trim();
    if (n) recipients.push({ ref, name: n, phone: String(phone ?? "").trim(), role_label: String(role_label ?? "Contact").trim() || "Contact" });
  };
  add("spoc", loc?.spoc_name, loc?.spoc_phone, "SPOC");
  add("principal", loc?.principal_name, loc?.principal_phone, "Principal");
  add("cluster_head", loc?.cluster_head_name, loc?.cluster_head_phone, "Cluster Head");
  (loc?.contacts ?? []).forEach((c: any, i: number) => add(`contact:${i}`, c?.name, c?.phone, c?.role_label));

  return NextResponse.json({
    ...art,
    // Kept so nothing that already reads `share` breaks; it is the most recent active link.
    share: links[0] ? { token: links[0].token, allow_updates: !!links[0].allow_updates, created_at: links[0].createdAt } : null,
    shares: links.map((l) => ({
      token: l.token, allow_updates: !!l.allow_updates, created_at: l.createdAt,
      recipient_name: l.recipient_name ?? null, recipient_phone: l.recipient_phone ?? null,
      recipient_role_label: l.recipient_role_label ?? null, recipient_ref: l.recipient_ref ?? null,
    })),
    recipients,
  });
});
