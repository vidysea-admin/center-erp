import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { BatchMember, PublicToken } from "@/models";
import { assertBatchInScope } from "@/lib/rules";
import { audit } from "@/lib/audit";

// Admin/Ops management of public capability links (2026-08-11):
//   POST {purpose:"register", location, program?}  → one shareable self-registration link
//   POST {purpose:"feedback", batch}               → one link per active roster member
// GET ?purpose=&location=&batch= lists tokens; PATCH is on the [id] route (deactivate).

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations", "Location");
  const sp = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = {};
  if (sp.get("purpose")) filter.purpose = sp.get("purpose");
  if (sp.get("location")) { assertLocationInScope(user, sp.get("location")!); filter.location = sp.get("location"); }
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

  if (purpose === "feedback") {
    if (!body.batch) throw new HttpError(400, "batch is required for feedback links");
    await assertBatchInScope(user, String(body.batch));
    const members = await BatchMember.find({ batch: body.batch, left_on: null })
      .populate("candidate", "name phone").lean<any[]>();
    const items = [];
    for (const m of members) {
      const existing = await PublicToken.findOne({ purpose: "feedback", batch_member: m._id, active: true }).lean<any>();
      if (existing) { items.push({ ...existing, batch_member: m }); continue; }
      const doc = await PublicToken.create({
        token: crypto.randomBytes(16).toString("hex"),
        purpose, batch_member: m._id, created_by: user.id,
      });
      items.push({ ...doc.toObject(), batch_member: m });
    }
    await audit({ entity: "Batch", entityId: body.batch, field: "feedback_links", newValue: `${items.length} link(s)`, actor: user.id });
    return NextResponse.json({ items }, { status: 201 });
  }

  throw new HttpError(400, "purpose must be register or feedback");
});
