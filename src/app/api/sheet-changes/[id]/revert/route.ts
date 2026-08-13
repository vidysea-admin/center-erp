import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { LocationTarget, Program, SheetChange } from "@/models";
import { audit } from "@/lib/audit";

// Rollback for an applied sheet change (2026-08-13, Umesh: "hum rollback kar paayein purane data
// mein"). Scope is deliberately narrow: only "Update target" writes a plain value that can be
// put back exactly. Start/Hold/Stop/Close spawn follow-up actions and operational state — undoing
// those is a decision, not a value swap, so the review flow (not a button) owns it.
export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "sheet.approve");
  const { id } = await ctx.params;

  const change = await SheetChange.findById(id);
  if (!change) throw new HttpError(404, "Change not found");
  if (change.status !== "Actioned" || change.action_taken !== "Update target") {
    throw new HttpError(400,
      "Only an applied \"Update target\" change can be reverted — status actions (start/hold/stop/close) carry follow-ups and are undone through the location screen, with a reason.");
  }
  if (!change.location) throw new HttpError(400, "Change has no matched location.");
  if (!change.field_name?.startsWith("approved_target:")) throw new HttpError(400, "Not a target change.");

  const code = change.field_name.split(":")[1];
  const program = await Program.findOne({ code }).lean<{ _id: unknown }>();
  if (!program) throw new HttpError(400, `Program ${code} not found.`);

  // The same strictness as the apply (sync S1-1): a value we cannot read confidently is a
  // question for a human. old_value blank means the sheet had no target before — revert unsets.
  const raw = String(change.old_value ?? "").trim().replace(/,/g, "");
  const hadValue = /^\d+$/.test(raw);
  if (!hadValue && raw !== "") {
    throw new HttpError(400, `The previous value "${change.old_value}" is not a whole number — set the target by hand on the location instead.`);
  }

  const before = await LocationTarget.findOne({ location: change.location, program: program._id }).lean<{ approved_target?: number }>();
  await LocationTarget.findOneAndUpdate(
    { location: change.location, program: program._id },
    hadValue ? { $set: { approved_target: Number(raw) } } : { $unset: { approved_target: 1 } },
    { upsert: true },
  );

  change.note = `${change.note ? change.note + " | " : ""}Reverted to "${change.old_value ?? ""}" by ${user.email ?? user.id}`;
  change.status = "Ignored"; // the applied action stands undone; the row stays as history
  await change.save();

  await audit({
    entity: "LocationTarget", entityId: change.location, field: "approved_target",
    oldValue: before?.approved_target, newValue: hadValue ? Number(raw) : null,
    actor: user.id, actorType: "EXTERNAL_SYNC",
  });

  return NextResponse.json({ item: change, reverted_to: hadValue ? Number(raw) : null });
});
