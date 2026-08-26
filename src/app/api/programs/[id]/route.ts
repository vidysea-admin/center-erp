import { NextResponse } from "next/server";
import { itemRoutes } from "@/lib/crud";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Program } from "@/models";
import { audit } from "@/lib/audit";
import { maskProgramMoney } from "../route";

export const { GET, PATCH } = itemRoutes({
  model: Program, entity: "Program", scopeField: null,
  fields: ["code", "name", "duration_days", "buffer_days", "default_batch_size", "requires_lab", "trainer_skill", "completion_deadline_days", "operating_days", "active", "scheme", "qp_code", "nsqf_level", "sector", "scheme_priority", "mandatory_trainer_docs", "hours", "contract_amount"],
  writeRoles: ["Admin"],
  // R-H: the admin-only money field is masked for every other reader, list and item alike.
  async mapItems(items, user) {
    return maskProgramMoney(items, (user as any)?.role === "Admin");
  },
});

// 2026-08-25 (Umesh, feedback-inbox): the Programs dropdown had no delete option at all. Umesh
// chose a real, unconditional delete here ("Delete hamesha allow karo, Admin ki marzi") rather
// than this codebase's usual deactivate-only master-row pattern — no usage/reference check.
// itemRoutes() (src/lib/crud.ts) only ever exports {GET, PATCH}, so this is a standalone export,
// matching the batches/[id]/route.ts DELETE pattern.
export const DELETE = apiHandler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "programs.delete");
  const { id } = await ctx.params;
  const program = await Program.findById(id).select("code name").lean<any>();
  if (!program) throw new HttpError(404, "Program not found");
  await Program.deleteOne({ _id: id });
  await audit({ entity: "Program", entityId: id, field: "delete", newValue: `${program.code} (${program.name}) deleted`, actor: user.id });
  return NextResponse.json({ deleted: program.code });
});
