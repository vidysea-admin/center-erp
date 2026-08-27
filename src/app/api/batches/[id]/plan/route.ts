import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { Batch, Location, PublicToken } from "@/models";
import { assertBatchInScope, occupantName, planArtifact, recipientKey, slotGeneration, storedTokenKey } from "@/lib/rules";
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
    .select("token allow_updates createdAt recipient_name recipient_phone recipient_role_label recipient_ref recipient_occupant recipient_location recipient_key")
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
      .select("spoc_name spoc_phone principal_name principal_phone cluster_head_name cluster_head_phone contacts spoc_gen principal_gen cluster_head_gen").lean<any>() : null;
    // QA-1505 (cycle 2): the NAME is no longer this route's own reading of the location document.
    // Cycle 1's manifest claimed both doors called occupantName(); a checker read the imports and
    // found only this one passing whatever it had picked up itself, which is the ARCHITECTURE §3
    // "two readers of one fact" condition the shared helper exists to remove — reintroduced inside
    // the change written to prevent it (QA-616 is the same defect one release earlier). It cost a
    // real divergence: with two contact subdocuments sharing an `_id`, this route offered two
    // people under one ref with two different keys while the mint — which resolves `contact:<id>`
    // by taking the FIRST row with that id — computed one key for both and revoked the wrong
    // person. The duplicate id is refused at the write door now (models/index.ts), and this route
    // no longer has an opinion of its own about who occupies a ref either. `add()` therefore takes
    // the ref and the fields that are NOT identity (phone, role label); the name comes back from
    // the one function that answers that question.
    const add = (ref: string, phone?: string, role_label?: string) => {
      const n = occupantName(loc, ref);
      if (!n) return;
      const role = String(role_label ?? "Contact").trim() || "Contact";
      const phoneStr = String(phone ?? "").trim();
      // QA-621 cycle 4: same generation-aware key the mint route computes (public-tokens/route.ts)
      // - this is the "Send to" picker's twin door, and it must agree on WHO a slot's occupant is
      // right now or a stale/live decision here would disagree with what mint actually does.
      // QA-558 / QA-621 cycle 5: `n` IS this ref's current occupant as the centre records it (it is
      // read from the same location document, two lines up), which is exactly what the mint route
      // snapshots into the key - so the picker and the mint still compute one identical key, and
      // "this person already has a link" cannot disagree with what sending actually replaces.
      // QA-1503 cycle 6: ...and on WHICH CENTRE, because `spoc` is a role on a centre and a batch
      // can be moved to another one.
      recipients.push({ ref, key: recipientKey({ recipient_ref: ref, slot_generation: slotGeneration(loc, ref), occupant_name: n, location_id: loc?._id ? String(loc._id) : "" }), name: n, phone: phoneStr, role_label: role });
    };
    add("spoc", loc?.spoc_phone, "SPOC");
    add("principal", loc?.principal_phone, "Principal");
    add("cluster_head", loc?.cluster_head_phone, "Cluster Head");
    // QA-615: the contact's OWN id, not its position. `contact:<index>` moved when the admin
    // removed an earlier contact, and sending to whoever slid into that slot revoked the previous
    // occupant's live link. An `_id` does not slide.
    (loc?.contacts ?? []).forEach((c: any) => add(c?._id ? `contact:${String(c._id)}` : "", c?.phone, c?.role_label));
  }

  return NextResponse.json({
    ...art,
    // Kept so nothing that already reads `share` breaks; it is the most recent active link.
    share: links[0] ? { token: links[0].token, allow_updates: !!links[0].allow_updates, created_at: links[0].createdAt } : null,
    shares: links.map((l) => ({
      _id: String(l._id), token: l.token, allow_updates: !!l.allow_updates, created_at: l.createdAt,
      recipient_name: l.recipient_name ?? null,
      // Same reason as the list above: a phone number is shown to whoever may send to it.
      recipient_phone: mayShare ? (l.recipient_phone ?? null) : null,
      recipient_role_label: l.recipient_role_label ?? null, recipient_ref: l.recipient_ref ?? null,
      // QA-611: the identity the screen compares on, so it never re-derives its own answer.
      // QA-558 / QA-621 cycle 5: when a row predates the stored key, storedTokenKey() rebuilds it
      // from the ROW'S OWN recorded fields - the same function the mint route's upgrade pass uses,
      // so the screen and the mint cannot end up holding two different keys for one link.
      recipient_key: storedTokenKey(l),
    })),
    recipients,
    may_share: mayShare,
  });
});
