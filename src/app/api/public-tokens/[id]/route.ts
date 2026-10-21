import { ADMIN_OPS } from "@/lib/roles";
import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, requireEdit, isScoped, assertLocationInScope, HttpError, readJson } from "@/lib/authz";
import { PublicToken, BatchMember, Batch } from "@/models";
import { audit } from "@/lib/audit";

// PATCH { active: false } — revoke a public link. (Re-enable with active: true.)
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, ...ADMIN_OPS);
  requireEdit(user);
  const { id } = await ctx.params;
  const body = await readJson(req);
  const doc = await PublicToken.findById(id);
  if (!doc) throw new HttpError(404, "Token not found");
  if (isScoped(user)) {
    // Center Manager: a link is revoked/re-enabled only for their own centres (the token's centre, or
    // the centre of the batch its member sits in). Refused before any write.
    let loc: unknown = doc.location;
    if (!loc && doc.batch_member) {
      const m = await BatchMember.findById(doc.batch_member).select("batch").lean<any>();
      const b = m ? await Batch.findById(m.batch).select("location").lean<any>() : null;
      loc = b?.location;
    }
    if (!loc) throw new HttpError(403, "Location out of scope");
    assertLocationInScope(user, String(loc));
  }
  doc.active = !!body.active;
  await doc.save();
  await audit({ entity: "PublicToken", entityId: doc._id, field: "active", newValue: doc.active, actor: user.id });
  return NextResponse.json({ item: doc });
});
