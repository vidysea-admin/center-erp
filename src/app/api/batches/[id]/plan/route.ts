import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { Batch, Location, PublicToken } from "@/models";
import { assertBatchInScope, planArtifact, recipientKey } from "@/lib/rules";
import { canShareLinks } from "@/lib/permissions";

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
    .select("token allow_updates createdAt recipient_name recipient_phone recipient_role_label recipient_ref recipient_key")
    .sort({ createdAt: -1 }).lean<any[]>();

  // QA-614: this endpoint is readable by anyone who passes assertBatchInScope - which includes a
  // Trainer, for every batch they run. Centre staff names and personal phone numbers are not theirs
  // to have, and the "Send to" list was gated in the UI only, which is not a gate. The right to see
  // WHO COULD BE SENT the plan follows the right to send it: the same check POST /api/public-tokens
  // makes before minting a link. Everyone else still gets the plan and their own share list.
  // QA-617: one predicate, and it runs the mint gate itself rather than restating it. The first
  // version restated it and got it wrong in BOTH directions - a view-only holder was shown the
  // staff list and their phone numbers but could not send, and an Admin with `can_edit: false`
  // (the schema default) could send but was shown nobody.
  const mayShare = await canShareLinks(user);

  const recipients: { ref: string; key: string; name: string; phone: string; role_label: string }[] = [];
  if (mayShare) {
    const b = await Batch.findById(id).select("location").lean<any>();
    const loc = b?.location ? await Location.findById(b.location)
      .select("spoc_name spoc_phone principal_name principal_phone cluster_head_name cluster_head_phone contacts").lean<any>() : null;
    const add = (ref: string, name?: string, phone?: string, role_label?: string) => {
      const n = String(name ?? "").trim();
      if (!n) return;
      const role = String(role_label ?? "Contact").trim() || "Contact";
      const phoneStr = String(phone ?? "").trim();
      recipients.push({ ref, key: recipientKey({ recipient_ref: ref, recipient_phone: phoneStr, recipient_name: n, recipient_role_label: role }), name: n, phone: phoneStr, role_label: role });
    };
    add("spoc", loc?.spoc_name, loc?.spoc_phone, "SPOC");
    add("principal", loc?.principal_name, loc?.principal_phone, "Principal");
    add("cluster_head", loc?.cluster_head_name, loc?.cluster_head_phone, "Cluster Head");
    // QA-615: the contact's OWN id, not its position. `contact:<index>` moved when the admin
    // removed an earlier contact, and sending to whoever slid into that slot revoked the previous
    // occupant's live link. An `_id` does not slide.
    (loc?.contacts ?? []).forEach((c: any) => add(c?._id ? `contact:${String(c._id)}` : "", c?.name, c?.phone, c?.role_label));
  }

  return NextResponse.json({
    ...art,
    // Kept so nothing that already reads `share` breaks; it is the most recent active link.
    share: links[0] ? { token: links[0].token, allow_updates: !!links[0].allow_updates, created_at: links[0].createdAt } : null,
    shares: links.map((l) => ({
      token: l.token, allow_updates: !!l.allow_updates, created_at: l.createdAt,
      recipient_name: l.recipient_name ?? null,
      // Same reason as the list above: a phone number is shown to whoever may send to it.
      recipient_phone: mayShare ? (l.recipient_phone ?? null) : null,
      recipient_role_label: l.recipient_role_label ?? null, recipient_ref: l.recipient_ref ?? null,
      // QA-611: the identity the screen compares on, so it never re-derives its own answer.
      recipient_key: l.recipient_key ?? recipientKey(l),
    })),
    recipients,
    may_share: mayShare,
  });
});
