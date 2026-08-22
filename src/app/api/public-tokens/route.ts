import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, requireEdit, assertLocationInScope, isScoped, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, PublicToken } from "@/models";
import { assertBatchInScope, recipientKey } from "@/lib/rules";
import { audit } from "@/lib/audit";

// Admin/Ops management of public capability links (2026-08-11):
//   POST {purpose:"register", location, program?}  → one shareable self-registration link
//   POST {purpose:"feedback", batch}               → one link per active roster member
//   POST {purpose:"attendance", batch}             → one link per active roster member
//     (2026-08-13, Manish: "bacche puchte hain sir mera kitna ho gaya" — each student gets a
//      link to their own days/hours/eligibility; same fan-out machinery as feedback)
// GET ?purpose=&location=&batch= lists tokens; PATCH is on the [id] route (deactivate).

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "feedback.links"); // read follows the same togglable right as write
  const sp = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = {};
  if (sp.get("purpose")) filter.purpose = sp.get("purpose");
  if (sp.get("location")) { assertLocationInScope(user, sp.get("location")!); filter.location = sp.get("location"); }
  // Rule 38: tokens ARE the credential — a scoped user must never see another location's
  // links. Register tokens carry a location; feedback tokens are reached via their batch,
  // so both paths are constrained to the caller's scope.
  if (isScoped(user)) {
    const locIds = user.location_scope;
    const batchIds = await Batch.find({ location: { $in: locIds } }).distinct("_id");
    const memberIds = await BatchMember.find({ batch: { $in: batchIds } }).distinct("_id");
    filter.$or = [
      { location: { $in: locIds } },
      { batch_member: { $in: memberIds } },
    ];
  }
  const items = await PublicToken.find(filter)
    .sort({ createdAt: -1 }).limit(200)
    .populate("location", "name code")
    .populate("program", "name code")
    .populate({ path: "batch_member", populate: { path: "candidate", select: "name phone" } })
    .lean<any[]>();
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations", "Location");
  requireEdit(user);
  await requirePerm(user, "feedback.links"); // togglable (2026-08-11)
  const body = await req.json();
  const purpose = String(body.purpose ?? "");

  if (purpose === "register") {
    if (!body.location) throw new HttpError(400, "location is required for a registration link");
    assertLocationInScope(user, String(body.location));
    const doc = await PublicToken.create({
      token: crypto.randomBytes(16).toString("hex"),
      purpose, location: body.location, program: body.program || undefined,
      created_by: user.id,
    });
    await audit({ entity: "PublicToken", entityId: doc._id, field: "create", newValue: "register link", actor: user.id });
    return NextResponse.json({ item: doc }, { status: 201 });
  }

  if (purpose === "feedback" || purpose === "attendance") {
    if (!body.batch) throw new HttpError(400, `batch is required for ${purpose} links`);
    await assertBatchInScope(user, String(body.batch));
    const members = await BatchMember.find({ batch: body.batch, left_on: null })
      .populate("candidate", "name phone").lean<any[]>();
    const items = [];
    for (const m of members) {
      const existing = await PublicToken.findOne({ purpose, batch_member: m._id, active: true }).lean<any>();
      if (existing) { items.push({ ...existing, batch_member: m }); continue; }
      const doc = await PublicToken.create({
        token: crypto.randomBytes(16).toString("hex"),
        purpose, batch_member: m._id, created_by: user.id,
      });
      items.push({ ...doc.toObject(), batch_member: m });
    }
    await audit({ entity: "Batch", entityId: body.batch, field: `${purpose}_links`, newValue: `${items.length} link(s)`, actor: user.id });
    return NextResponse.json({ items }, { status: 201 });
  }

  // QA-152 part 2 (-82): one link per batch plan; re-minting rotates the old one off.
  //
  // REQ-392 / REQ-393 (QA-557, QA-558): that rotation was correct while a plan had exactly one
  // link. Once a plan is shared PERSON-WISE it becomes a defect, and a quiet one: sending the
  // Principal their plan would deactivate the SPOC's working link, with nothing telling either of
  // them. The first symptom is a centre-side person reporting a dead link days later and nothing in
  // the product able to explain why. So the revocation is scoped to the same recipient on the same
  // batch - re-sharing to a person still rotates THAT person's old link off, and nobody else's.
  //
  // WHO a recipient is, is `recipientKey()` in lib/rules.ts and nowhere else. -191 answered that
  // question here, inline, with the phone string - and a checker put the S1 straight back through
  // it. This comment used to explain that phone-based rule; it is left corrected rather than
  // deleted, because a comment describing a rule the code no longer has is worse than no comment
  // (QA-606, learned two units ago on the same afternoon).
  if (purpose === "plan") {
    if (!body.batch) throw new HttpError(400, "batch is required for a plan link");
    await assertBatchInScope(user, String(body.batch));
    const b = await Batch.findById(body.batch).select("plan_enabled code").lean<any>();
    if (!b) throw new HttpError(404, "Batch not found");
    if (!b.plan_enabled) throw new HttpError(409, "This batch has no plan yet — create one first.");

    const rName = String(body.recipient_name ?? "").trim();
    const rPhone = String(body.recipient_phone ?? "").trim();
    const rRole = String(body.recipient_role_label ?? "").trim() || "Contact";
    if (!rName) {
      throw new HttpError(400, "recipient_name is required — a plan link records who it was sent to, so it can be listed and revoked for that person alone.");
    }
    // QA-611: the key is WHO, computed once by recipientKey() and stored, so the revocation is an
    // exact match on an indexed field. -191 matched on the phone string and a centre recording one
    // landline for its SPOC and its Principal had them cutting each other off - the S1 this unit
    // exists to close, alive again through the line written to close it.
    const rKey = recipientKey({
      recipient_ref: body.recipient_ref, recipient_phone: rPhone,
      recipient_name: rName, recipient_role_label: rRole,
    });

    // QA-616: `recipient_key` is stored, so a token minted before it existed carries none - and the
    // revocation, which matches on the key, could never touch it. Meanwhile the screen recomputes
    // the key when it LISTS shares, so it happily offered "Re-send" for a link that sending could
    // not replace: the display reader fell back and the revocation reader did not. Two readers of
    // one fact, disagreeing, again.
    //
    // Backfilled here rather than on the GET, because a read that writes is a surprise, and this is
    // bounded - a handful of tokens on one batch, at the moment somebody is already writing.
    const unkeyed = await PublicToken.find({ purpose: "plan", batch: body.batch, recipient_key: { $in: [null, ""] } })
      .select("recipient_ref recipient_phone recipient_name recipient_role_label").lean<any[]>();
    for (const t of unkeyed) {
      await PublicToken.updateOne({ _id: t._id }, { $set: { recipient_key: recipientKey(t) } });
    }

    await PublicToken.updateMany({ purpose: "plan", batch: body.batch, recipient_key: rKey, active: true }, { $set: { active: false } });

    const doc = await PublicToken.create({
      token: crypto.randomBytes(16).toString("hex"),
      purpose, batch: body.batch, allow_updates: !!body.allow_updates, created_by: user.id,
      recipient_name: rName, recipient_phone: rPhone || undefined,
      recipient_role_label: rRole, recipient_ref: body.recipient_ref || undefined,
      recipient_key: rKey,
    });
    await audit({ entity: "Batch", entityId: body.batch, field: "plan_link", newValue: `shared with ${rName} (${rRole})${body.allow_updates ? " — link may tick status" : " — read-only"}`, actor: user.id });
    return NextResponse.json({ item: doc }, { status: 201 });
  }

  throw new HttpError(400, "purpose must be register, feedback, attendance or plan");
});
