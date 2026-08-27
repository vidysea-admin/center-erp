import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate, Location, LocationTarget, Program, SheetChange, Trainer } from "@/models";
import { audit } from "@/lib/audit";
import { canRevert, isSecretSheetField, maskSheetChange } from "@/lib/sync";

// Rollback for an applied sheet change (2026-08-13, Umesh: "hum rollback kar paayein purane data
// mein"). Scope is deliberately narrow: "Update target" and "Apply value" write a plain value
// that can be put back exactly. Start/Hold/Stop/Close spawn follow-up actions and operational
// state — undoing those is a decision, not a value swap, so the review flow (not a button) owns it.
export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "sheet.approve");
  const { id } = await ctx.params;

  const change = await SheetChange.findById(id);
  if (!change) throw new HttpError(404, "Change not found");
  // QA-989 (checker on qa-234 cycle 1): ONE predicate, shared with the list route that decides
  // whether to render the button at all. This used to be two guards here and a third, looser copy
  // in sync/page.tsx, so every applied tc_status:/tc_id: row showed a Revert button whose door
  // answered 400 "Not a target change." after the user had already confirmed.
  const revertable = canRevert(change);
  if (!revertable.ok) throw new HttpError(400, revertable.why);

  // Whether THIS row carries a credential. This door is gated on sheet.approve ALONE — deliberately,
  // because reverting is an operational act a non-Admin reviewer is meant to perform. What must not
  // follow from that right is READING the credential.
  //
  // QA-1253 cycle 3: `secretField` and a private `maskChangeSecrets` used to live here, and that
  // private copy was the third spread of a document whose value lives in three properties — it
  // masked two, and `impact_snapshot.{apply,revert}` went out in the clear inside the same reply.
  // Both the test and the mask are imported now, so the count is one function's job and not the
  // next author's memory.
  const secretField = isSecretSheetField(change.field_name);

  // Generic field write — put back exactly what was there (the resolved old value when the
  // tab-mapping engine stored one, else the sheet's old text; blank means unset).
  if (change.action_taken === "Apply value") {
    const entityType = (change.entity_type as string) ?? "Location";
    const Model = entityType === "Trainer" ? Trainer : entityType === "Candidate" ? Candidate : Location;
    const targetId = change.entity ?? (entityType === "Location" ? change.location : null);
    if (!targetId) throw new HttpError(400, "Change has no matched record.");
    const doc = await Model.findById(targetId);
    if (!doc) throw new HttpError(404, `${entityType} not found.`);
    const snap = change.impact_snapshot as any;
    const restore = snap && snap.revert !== undefined ? snap.revert : (change.old_value ?? "");
    // QA-1502 (QA-558/QA-621 cycle 6): the twin of the "Apply value" write in lib/sync.ts, and it
    // was the other route that could rename a centre's SPOC without the slot's generation counter
    // moving — the half of a plan link's identity that tells "re-sent to the same person" apart
    // from "a different person holds this chair now". Nothing is added here: the bump is structural
    // and fires on this save (LocationSchema.pre("save"), models/index.ts).
    doc.set(change.field_name, restore === "" ? undefined : restore);
    await doc.save({ validateModifiedOnly: true });
    // QA-1062 cycle 2 (2026-08-25): this note used to embed the restored value, and for a
    // tc_password row that PERSISTED a live portal credential into a field the list route's mask
    // does not cover (it masks old_value/new_value only) — so the door reopened everything the gate
    // had just closed, one field over. A checker proved it end to end.
    // The value is already on the row in old_value; repeating it in prose bought nothing and
    // escaped the mask, so this note records the ACT and not the value — for every field on THIS
    // branch, not only secret ones, because a note that sometimes quotes and sometimes does not is
    // a rule the next reader has to remember. QA-805 already put the fact in `reverted_at`.
    // The target-row branch further down still quotes its old value: that branch only ever handles
    // `approved_target:<CODE>`, i.e. a whole number, so nothing there is a credential. Said out
    // loud because "for every field" would have been a false universal one branch away.
    change.note = `${change.note ? change.note + " | " : ""}Reverted by ${user.email ?? user.id}`;
    change.reverted_at = new Date(); // QA-805: the fact, so no screen has to grep a note for it
    change.status = "Ignored";
    await change.save();
    await audit({
      entity: entityType, entityId: doc._id, field: change.field_name,
      oldValue: change.new_value, newValue: change.old_value,
      actor: user.id, actorType: "EXTERNAL_SYNC",
    });
    // ...and the RESPONSE was the third copy: `reverted_to` handed back the raw old value, and
    // `item` is the unmasked document. Both are gated on sheet.approve alone, so the login the
    // gate fix was written for could read the password out of the reply. A secret field now
    // reports that it was restored, not what to.
    // NOTE THE ORDER, because getting it wrong writes bullets into a centre's live password: the
    // restore above reads `snap.revert` from the DOCUMENT, and only this outgoing COPY is masked.
    // `maskSheetChange` returns a new object and never mutates its input, for exactly this reason.
    return NextResponse.json(secretField
      ? { item: maskSheetChange(change.toObject(), false), reverted_to: change.old_value ? "(restored)" : null }
      : { item: change, reverted_to: change.old_value ?? null });
  }
  if (!change.location) throw new HttpError(400, "Change has no matched location.");

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
  change.reverted_at = new Date(); // QA-805: recorded as a fact, not inferred from prose
  change.status = "Ignored"; // the applied action stands undone; the row stays as history
  await change.save();

  await audit({
    entity: "LocationTarget", entityId: change.location, field: "approved_target",
    oldValue: before?.approved_target, newValue: hadValue ? Number(raw) : null,
    actor: user.id, actorType: "EXTERNAL_SYNC",
  });

  return NextResponse.json({ item: change, reverted_to: hadValue ? Number(raw) : null });
});
