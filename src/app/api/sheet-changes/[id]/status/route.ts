import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { FollowUpAction, SheetChange } from "@/models";
import { audit } from "@/lib/audit";

// -218 (Umesh, 23/08): "there is still no edit button to ignored status of sync messages" — and
// then, asked whether he wanted only the mis-clicked ones back: "hume sirf abhi wale, joh galti se,
// hume fix nhi karna hai. hume woh functionality bana ke deni hai ki ek baar jo admin ne mark kar
// diya status, woh baad me chahe toh edit kar sakta hai, status change bhi kar sakta hai, with
// confirmation."
//
// He is right that it was a one-way door, and it was one at BOTH layers. The three routes that
// existed only ever pushed a row forward: bulk-ignore (Open -> Ignored), apply (Open -> Actioned),
// revert (Actioned -> Ignored). Nothing brought anything back, so a wrong press of
// "Bulk Ignore (No action)" was permanent — and `revert` dropped rows into the same terminal state.
//
// WHY `Actioned` IS NOT AN ALLOWED TARGET, said out loud rather than quietly omitted: "Actioned"
// means a value was actually written to a record. Setting it by hand would put a claim in the
// history that nothing performed. Applying is what makes a row Actioned, and that door already
// exists. If he wants that too it is a separate decision.
const ALLOWED = ["Open", "Ignored"] as const;

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);           // Rule 39: can_edit=false is view-only everywhere, granted rights included
  // The SAME right bulk-ignore and apply require. Deliberately a permission and not a role literal:
  // six times in eight releases a control was gated on one thing while its door checked another
  // (QA-712, QA-723, QA-754, QA-775, QA-785, QA-791), and every one of those was a button someone
  // could see and not press. The screen gates on this same key.
  await requirePerm(user, "sheet.approve");

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const next = String(body.status ?? "").trim();
  const reason = String(body.reason ?? "").trim().slice(0, 200);

  if (!ALLOWED.includes(next as (typeof ALLOWED)[number])) {
    throw new HttpError(400,
      `A sheet change can be moved to ${ALLOWED.join(" or ")}. "Actioned" is what applying a change records — it is not set by hand.`);
  }

  const change = await SheetChange.findById(id);
  if (!change) throw new HttpError(404, "Change not found");
  const was = String(change.status);
  if (was === next) throw new HttpError(400, `This change is already ${next}. Nothing has been changed.`);

  // Rule 7 stays exactly as it is on the Ignore door: a change with outstanding follow-ups is not
  // settled by a status edit either. Otherwise this becomes a way around that rule rather than a
  // way to correct a mistake.
  if (next === "Ignored") {
    const pending = await FollowUpAction.countDocuments({ source_change: change._id, status: "Pending" });
    if (pending) {
      throw new HttpError(409,
        `This change still has ${pending} follow-up${pending === 1 ? "" : "s"} outstanding, so it cannot be closed yet. Finish or cancel them first. Nothing has been changed.`);
    }
  }

  // Re-opening: "No action" is a label the IGNORE wrote when nobody had acted (lib/sync.ts,
  // bulkIgnore) — it is not history and must not survive a re-open, or the row comes back to the
  // review queue already claiming it was dealt with. A REAL action ("Apply value", "Update target",
  // a status action) is history and stays, because that change really did happen.
  const invented = change.action_taken === "No action";
  if (next === "Open") {
    if (invented) change.action_taken = null;
    change.actioned_at = undefined as any;
  } else {
    change.actioned_at = new Date();
  }
  change.status = next as any;
  change.actor = user.id as any;
  const trail = `Status ${was} -> ${next} by ${user.email ?? user.id}${reason ? `: ${reason}` : ""}`;
  change.note = `${change.note ? change.note + " | " : ""}${trail}`;
  await change.save();

  await audit({
    entity: "SheetChange", entityId: change._id, field: "status",
    oldValue: was, newValue: next, actor: user.id, actorType: "USER",
  });

  return NextResponse.json({
    item: { _id: change._id, status: change.status, action_taken: change.action_taken ?? null },
    // What the row lost, so the screen can say it rather than guess.
    cleared_no_action: next === "Open" && invented,
  });
});
