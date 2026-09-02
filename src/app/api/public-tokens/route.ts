import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, requireEdit, assertLocationInScope, isScoped, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, Location, Program, PublicToken } from "@/models";
import { assertBatchInScope, mintMemberLinks, occupantName, recipientKey, slotGeneration, storedTokenKey } from "@/lib/rules";
import { audit } from "@/lib/audit";

// Admin/Ops management of public capability links (2026-08-11):
//   POST {purpose:"register", location, program}   → one shareable self-registration link
//     (QA-888: this read `program?` and was RIGHT until -229 made the field required, two lines
//      below. I made it stale in the same commit that made it wrong and did not update it; the
//      checker found it. A comment describing a rule the code no longer has is worse than no
//      comment, QA-606.)
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
    if (!body.location) throw new HttpError(400, "Choose the centre this link registers candidates into.");
    let mintWarning: string | undefined;   // QA-1187
    assertLocationInScope(user, String(body.location));
    // 2026-08-24 (Umesh): "candidate k self registration link mai abhi bss location confirm hoti hai,
    // it should confirm location and program too jisse jo candidate register krega uska location and
    // program pre fixed rhegaa. vo khud nhi select krega."
    //
    // The COLUMN and both public doors have honoured a pinned programme since this token was written
    // (`PublicToken.program`, and the GET/POST one directory over) — the mint UI simply never sent one,
    // so every link ever shared asked the student to pick their own job role from the full active list.
    // Requiring it here, at the door, is what makes that unrepeatable: a screen can forget a field,
    // an API that refuses cannot.
    //
    // Links already in a WhatsApp thread are NOT touched. `loadToken` is unchanged and a programme-less
    // token still renders its picker, because rotating them off would kill a link somebody is holding
    // right now to punish a defect that was never theirs (the REQ-393 lesson: a dead link explains
    // nothing to the person holding it).
    // A-03 (24-Aug sheet, Shiv, spoken): a link may now also name a BATCH, and when it does the
    // programme is not asked for twice - the batch already has one, and letting the caller send a
    // different one would create a link whose two halves disagree. The batch decides.
    if (body.batch) {
      const b = await Batch.findById(String(body.batch)).select("code status location program target_size").lean<any>();
      if (!b) throw new HttpError(404, "That batch no longer exists — pick another one.");
      if (String(b.location) !== String(body.location)) {
        throw new HttpError(409, `${b.code} belongs to a different centre. A link cannot register candidates into a batch at another centre.`);
      }
      if (["Completed", "Cancelled", "Closed"].includes(b.status)) {
        throw new HttpError(409, `${b.code} is ${b.status} — a registration link cannot be created for a batch nobody can join.`);
      }
      // QA-1187: a link for a batch that is ALREADY at its target was minted in complete silence,
      // and the form it opens still tells the student they will be added to that batch. Whoever
      // copies that link into a WhatsApp thread has no way to know.
      // It is still MINTED, not refused - a batch can empty again by tomorrow, and killing the link
      // would be the REQ-393 mistake (a dead link explains nothing to whoever is holding it). What
      // changes is that the operator is TOLD, in the same reply, in words.
      const seated = await BatchMember.countDocuments({ batch: b._id, left_on: null });
      if (b.target_size && seated >= b.target_size) {
        mintWarning = `${b.code} already has ${seated} on its roster against a planned size of ${b.target_size}. `
          + "The link still works and anyone who fills it will be added to the roster, but they will be over the planned size and cannot finish enrolment until a place frees up. "
          + "Raise the batch size, or drop someone, before sending this to more people.";
      }
      body.program = String(b.program);
    }
    if (!body.program) {
      throw new HttpError(400, "Choose the programme this link registers candidates into. The candidate does not pick their own — the link decides it.");
    }
    const prog = await Program.findById(String(body.program)).select("name active").lean<any>();
    if (!prog) throw new HttpError(404, "That programme no longer exists — pick another one.");
    // Rule: a retired programme may stay on a record that already points at one, but nothing NEW may
    // be started under it (the `offerable` rule the pickers use, -115/QA-221). A registration link is
    // as new as it gets.
    if (prog.active === false) {
      throw new HttpError(409, `${prog.name} is retired — a new registration link cannot be created for it.`);
    }
    const loc = await Location.findById(String(body.location)).select("name").lean<any>();
    const doc = await PublicToken.create({
      token: crypto.randomBytes(16).toString("hex"),
      purpose, location: body.location, program: body.program,
      // A-03: the field has existed on this record since it was written; only the register purpose
      // never set it. Absent means exactly what it meant before - a centre-wide intake link - and
      // every link already in a WhatsApp thread keeps behaving the way it always did.
      ...(body.batch ? { batch: body.batch } : {}),
      created_by: user.id,
    });
    // The audit row names BOTH, because "register link" alone cannot answer the only question anybody
    // asks of it later: which centre and which job role did this link put people into.
    // A-03: and the BATCH, when there is one — otherwise the trail cannot answer the question this
    // link now decides, which is not only "which centre and job role" but "whose roster".
    const batchCode = body.batch ? (await Batch.findById(String(body.batch)).select("code").lean<any>())?.code : null;
    await audit({ entity: "PublicToken", entityId: doc._id, field: "create", actor: user.id,
      newValue: `register link (${loc?.name ?? "centre"} / ${prog.name}${batchCode ? ` / batch ${batchCode}` : " / centre-wide, no batch"})` });
    // QA-1187: the warning rides the same reply, so the screen that minted the link can say it
    // without a second round trip - the shape the roster doors already use for their own warning.
    return NextResponse.json({ item: doc, ...(mintWarning ? { warning: mintWarning } : {}) }, { status: 201 });
  }

  if (purpose === "feedback" || purpose === "attendance") {
    if (!body.batch) throw new HttpError(400, `batch is required for ${purpose} links`);
    await assertBatchInScope(user, String(body.batch));
    // QA-179: the mint-or-reuse-per-member shape moved to lib/rules.ts (mintMemberLinks) once a
    // second caller (the trainer-triggered assessment-date mail) needed the exact same logic —
    // one definition, not a second near-copy.
    const items = await mintMemberLinks(purpose, String(body.batch), user.id);
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
  // WHO a recipient is, is `recipientKey()` in lib/rules.ts and nowhere else - and after four wrong
  // answers it no longer DERIVES that from anything. The caller names the centre slot, this route
  // checks the slot still exists on that centre, and the key is that slot. Nothing falls back.
  // This comment has been corrected twice rather than deleted, because a comment describing a rule
  // the code no longer has is worse than no comment (QA-606).
  if (purpose === "plan") {
    if (!body.batch) throw new HttpError(400, "batch is required for a plan link");
    await assertBatchInScope(user, String(body.batch));
    const b = await Batch.findById(body.batch).select("plan_enabled code location").lean<any>();
    if (!b) throw new HttpError(404, "Batch not found");
    if (!b.plan_enabled) throw new HttpError(409, "This batch has no plan yet — create one first.");

    const rName = String(body.recipient_name ?? "").trim();
    const rPhone = String(body.recipient_phone ?? "").trim();
    const rRole = String(body.recipient_role_label ?? "").trim() || "Contact";
    if (!rName) {
      throw new HttpError(400, "recipient_name is required — a plan link records who it was sent to, so it can be listed and revoked for that person alone.");
    }

    // QA-621: the recipient must be one of THIS centre's people, named by their slot. Four
    // releases derived the identity instead (batch, phone, array index, name) and every one of
    // them merged two people or split one. The caller supplies the slot and it is checked here;
    // there is no fallback, because a fallback is a guess and every guess has been wrong.
    const rRef = String(body.recipient_ref ?? "").trim();
    const planLoc = await Location.findById(b.location)
      .select("spoc_name principal_name cluster_head_name contacts spoc_gen principal_gen cluster_head_gen").lean<any>();
    const offered = new Set<string>();
    if (String(planLoc?.spoc_name ?? "").trim()) offered.add("spoc");
    if (String(planLoc?.principal_name ?? "").trim()) offered.add("principal");
    if (String(planLoc?.cluster_head_name ?? "").trim()) offered.add("cluster_head");
    for (const c of planLoc?.contacts ?? []) if (c?._id && String(c?.name ?? "").trim()) offered.add(`contact:${String(c._id)}`);
    if (!rRef || !offered.has(rRef)) {
      throw new HttpError(400, rRef
        ? `"${rName}" is not one of this centre's contacts any more, so there is no way to tell which person this link belongs to. Pick them from the list on the plan screen, or add them to the centre first.`
        : "A plan link has to name WHICH of the centre's people it is for — pick them from the list rather than typing a name, so re-sending later replaces their link instead of adding a second one.");
    }
    // QA-611: the key is WHO, computed once by recipientKey() and stored, so the revocation is an
    // exact match on an indexed field. -191 matched on the phone string and a centre recording one
    // landline for its SPOC and its Principal had them cutting each other off - the S1 this unit
    // exists to close, alive again through the line written to close it.
    // QA-621 cycle 4: a slot ref alone is not enough - "spoc" names a role, and the role's
    // OCCUPANT can change (Location.spoc_name edited to a different person) without the ref
    // changing at all. slotGeneration() folds in the slot's current generation (0 for a slot that
    // has never changed occupant, or for a `contact:<id>` ref, which has no generation) so a mint
    // for a NEW occupant lands on a different key than the one the OLD occupant's link was keyed
    // under, and never revokes it. See SLOT_OCCUPANT_FIELDS / slotGenerationBumps in rules.ts.
    // QA-558 / QA-621 cycle 5: the generation alone still leaves TWO holes, and both are the same
    // family as everything before them. (1) `contact:<id>` has no generation, and an admin can
    // rename a contact row in place - same subdocument id, a different human in it - so the new
    // person's mint would revoke the old person's link exactly as -193 did. (2) the generation is
    // only correct while every write path that can rename a slot's occupant remembers to bump it,
    // and "remembers to" is how each of the last four fixes died. So the key ALSO carries a
    // snapshot of WHO the centre says occupies this ref right now, read server-side - never
    // `body.recipient_name`, which the caller controls and could aim at somebody else's link.
    // QA-1503 cycle 6: ...and WHICH CENTRE that ref was read off. `spoc` is a role on whatever
    // centre this batch sits on today, and `PATCH /api/batches/[id]` moves a batch between centres
    // — after which the new centre's SPOC minted a key byte-identical to the old centre's SPOC's
    // whenever the two shared a name, and killed their link. Nothing was renamed and no bump was
    // missed; the key was simply one field short of saying who it meant.
    const occName = occupantName(planLoc, rRef);
    const rKey = recipientKey({ recipient_ref: rRef, slot_generation: slotGeneration(planLoc, rRef), occupant_name: occName, location_id: planLoc?._id ? String(planLoc._id) : "" });
    if (!rKey) {
      // Unreachable while `offered` requires a non-empty name for every ref it admits - kept
      // because an empty key must never reach the revocation below, where it would match every
      // keyless token on the batch. A guard whose absence is only safe by coincidence is a bug
      // waiting for the coincidence to end.
      throw new HttpError(400, "This centre no longer records who occupies that slot, so there is no way to say whose link this would be.");
    }

    // QA-616: `recipient_key` is stored, so a token minted before it existed carries none - and the
    // revocation, which matches on the key, could never touch it. Meanwhile the screen recomputes
    // the key when it LISTS shares, so it happily offered "Re-send" for a link that sending could
    // not replace: the display reader fell back and the revocation reader did not. Two readers of
    // one fact, disagreeing, again.
    //
    // Backfilled here rather than on the GET, because a read that writes is a surprise, and this is
    // bounded - a handful of tokens on one batch, at the moment somebody is already writing.
    // QA-623: the backfill used to INVENT a key for a keyless row from its name, and a checker
    // showed that could revoke a different same-named person. With no fallback there is nothing to
    // invent: a row that carries a ref gets its key, and a row that does not is left alone. Those
    // are listed on the plan screen as links that belong to nobody the centre still lists, and are
    // revoked by hand rather than silently matched.
    //
    // QA-558 / QA-621 cycle 5: the same pass now also UPGRADES rows that carry an older
    // single-signal key (`ref:<ref>` / `ref:<ref>:g<n>`) to the two-signal format, so that
    // re-sending to the same person still rotates their own link off across this change. Every
    // input is the ROW'S OWN recorded fields (storedTokenKey() in rules.ts reads nothing from the
    // centre's current state), because deriving an old row's identity from today's occupant is
    // precisely the guess that made this an S1 five times.
    //
    // QA-1503 cycle 6: the format the pass looks for is now "does not start with `loc:`", which
    // also catches the two-signal keys cycle 1 wrote. A row it cannot rebuild — no recorded centre,
    // or no recorded person — keeps whatever key it has and simply matches no mint from here on.
    const stale = await PublicToken.find({
      purpose: "plan", batch: body.batch, recipient_ref: { $nin: [null, ""] },
      recipient_key: { $not: /^loc:/ },
    }).select("recipient_ref recipient_name recipient_occupant recipient_location recipient_key").lean<any[]>();
    for (const t of stale) {
      const upgraded = storedTokenKey(t);
      // "" means the row cannot say whose it is (no recorded name). Leave its key exactly as it
      // was rather than clearing it - it simply matches no mint from here on, which is the
      // QA-623 outcome: shown as belonging to nobody, revocable by hand, never silently matched.
      if (upgraded && upgraded !== String(t.recipient_key ?? "")) {
        await PublicToken.updateOne({ _id: t._id }, { $set: { recipient_key: upgraded } });
      }
    }

    await PublicToken.updateMany({ purpose: "plan", batch: body.batch, recipient_key: rKey, active: true }, { $set: { active: false } });

    const doc = await PublicToken.create({
      token: crypto.randomBytes(16).toString("hex"),
      purpose, batch: body.batch, allow_updates: !!body.allow_updates, created_by: user.id,
      recipient_name: rName, recipient_phone: rPhone || undefined,
      // ...and, separately from the name the sender saw, the centre's OWN record of who occupied
      // that ref at this moment. Two fields rather than one on purpose: `recipient_name` is what
      // the screen shows and the sender typed, which makes it an input; `recipient_occupant` is
      // what the identity in `recipient_key` was actually built from, which makes it evidence. The
      // day they disagree - a stale picker, a rename mid-session - the identity must be the one the
      // server read, and there has to be somewhere to see that it was.
      recipient_occupant: occName,
      // ...and the centre that ref was read off, for the same reason and in the same spirit: the
      // key must be rebuildable later from the row's OWN record, never from where this batch
      // happens to sit on the day somebody re-sends (QA-1503).
      recipient_location: planLoc?._id,
      recipient_role_label: rRole, recipient_ref: rRef,
      recipient_key: rKey,
    });
    await audit({ entity: "Batch", entityId: body.batch, field: "plan_link", newValue: `shared with ${rName} (${rRole})${body.allow_updates ? " — link may tick status" : " — read-only"}`, actor: user.id });
    return NextResponse.json({ item: doc }, { status: 201 });
  }

  throw new HttpError(400, "purpose must be register, feedback, attendance or plan");
});
