import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, CandidateResult, Closure } from "@/models";
import { assertBatchInScope, activeRoster, enrolledWithoutCan, isCertificateSettled, recomputeClosureAggregates, transitionBatch, upsertCandidateResult } from "@/lib/rules";
import { requireApproval } from "@/lib/approvals";
import { audit } from "@/lib/audit";

// -113 (Umesh, 18/08: "admin ke paas mark completed ka button aaye, aur wo press kar paye — jaise
// abhi wala press bhi nahi ho raha na").
//
// The two Mark-Completed buttons and the batch transition each refuse until the ROWS say they may
// fire: Rule 43 wants every roster member to carry a final result, Rule 46 wants every pass to hold
// a settled certificate. On AVP-GURU-RPLAVP-DST-01 that is 26 unmarked students and one pass with no
// certificate — real, missing facts, and the rules are right to hold. But an Admin looking at a batch
// that finished months ago has no way to say "this is how it ended" and be done.
//
// So this is the ADMIN door, built in the shape this codebase already uses for exactly this problem
// (Rule 19: a batch with daily logs may be force-closed by an Admin, with a reason). It does NOT
// weaken a rule and it does NOT invent a number. It writes the honest default for each outstanding
// row — a student with no result is FAILED (Umesh, -204; it wrote ABSENT until then), a pass with no
// certificate is NOT ISSUED — every row
// audited by name, under one reason the Admin types, and only then walks the batch to Completed.
//
// GET returns exactly what a press would settle, so the screen can say it before anything happens.

async function outstanding(batchId: string) {
  // activeRoster is already the NOT-dropped roster (left_on: null) — the same list Rule 43 walks.
  // -159 (QA-472): the PHONE rides on both lists. REQ-389 is the reason and it is not a preference:
  // "the portal ID when present, otherwise the phone" - and on the roster this week has been about,
  // two students share a name, so a list of names identifies nobody. -158 fixed one screen that had
  // this defect and left three; this is the payload all three of them read.
  const roster = await activeRoster(batchId);
  const live = new Set(roster.map((m: any) => String(m._id)));
  const rows = await CandidateResult.find({ batch: batchId }).populate("candidate", "name phone").lean<any[]>();
  const byMember = new Map(rows.map((r) => [String(r.batch_member), r]));
  // An UNMARKED member may have no result row at all, so the name cannot come from the row - it has
  // to come from the roster. Before this, a member with no row got `name: undefined` and was
  // rendered as nothing at all by the surfaces that .filter(Boolean) their names.
  const withCand = await BatchMember.find({ batch: batchId, left_on: null })
    .populate("candidate", "name phone").select("candidate").lean<any[]>();
  const candByMember = new Map(withCand.map((m: any) => [String(m._id), m.candidate]));
  const unmarked: { member: string; name?: string; phone?: string | null }[] = [];
  for (const m of roster) {
    const row = byMember.get(String(m._id));
    const cand = row?.candidate ?? candByMember.get(String(m._id));
    if (!row || row.result === "Pending") unmarked.push({ member: String(m._id), name: cand?.name, phone: cand?.phone ?? null });
  }
  const unsettled = rows.filter((r) => r.result === "Pass" && live.has(String(r.batch_member))
    && !isCertificateSettled(r.certificate_status))
    .map((r) => ({ id: String(r._id), name: r.candidate?.name, phone: r.candidate?.phone ?? null, status: r.certificate_status, has_file: !!r.certificate_file }));
  return { unmarked, unsettled, roster_count: roster.length, marked: roster.length - unmarked.length };
}

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "batches.manage");
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);
  const batch = await Batch.findById(id).select("status code").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  const o = await outstanding(id);
  const closure = await Closure.findOne({ batch: id }).select("assessment_status certification_status").lean<any>();
  // -205 (QA-676): the caption on the Overview said "Waiting on certificates" whenever certification
  // was Pending, and on the Gurugram batch that sentence was FALSE - zero certificates outstanding,
  // 17 of 17 Issued. The real hold was the portal ID, which the caption never mentions and this
  // payload never carried. Umesh went looking for a certificate problem because the screen sent him
  // there. A screen that names the wrong cause is worse than one that says nothing.
  const noCan = await enrolledWithoutCan(id);
  // QA-737 (-212, checker on qa-211): a missing portal ID only blocks while certification is still
  // unsigned. Once certification_status is Completed - derived earlier, or signed by an Admin - the
  // gap is a data-quality fact, not a door. The drawer listed it as an open blocker regardless, so
  // a batch that completes 200 through the ordinary door was shown as blocked. The list says which
  // of the two it is; the students are still named either way, because they still need the IDs.
  const certSigned = (closure?.certification_status ?? "Pending") === "Completed";
  return NextResponse.json({
    status: batch.status,
    can_complete_cleanly: o.unmarked.length === 0 && o.unsettled.length === 0,
    admin_only: true,
    ...o,
    no_portal_id: noCan,
    no_portal_id_blocks: !certSigned,
    closure: { assessment_status: closure?.assessment_status ?? "Pending", certification_status: closure?.certification_status ?? "Pending" },
  });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  requireRole(user, "Admin"); // same shape as Rule 19's force-close: this is an override, not a step
  await requirePerm(user, "batches.manage");
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);

  const body = await req.json().catch(() => ({}));
  const reason = String(body.reason ?? "").trim();
  if (!reason) throw new HttpError(400, "Say why this batch is being completed with rows still outstanding — it is recorded against every row this settles.");

  const batch = await Batch.findById(id).select("status code location").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");

  // QA-708 (-209, checker on qa-207): RPL M24's approval matrix gates `batch.complete`, and the
  // /transition door has always honoured it. This door did not - which did not matter while it was
  // the Admin's side entrance, and mattered the moment -207 made it the ONLY completion control on
  // the Overview: the matrix could be switched on and this button would walk straight past it.
  // Same call, same shape, same 202 as the door it replaced.
  {
    const gate = await requireApproval("batch.complete", user, {
      entity: "Batch", entity_id: id, location: batch.location,
      summary: `Complete batch ${batch.code}${body.reason ? ` — ${String(body.reason).trim()}` : ""}`,
      payload: { reason: body.reason, force: body.force === true },
    });
    if (gate) {
      return NextResponse.json({ pending_approval: true, request: gate.request, message: "Sent for approval." }, { status: 202 });
    }
  }

  if (["Completed", "Closed"].includes(batch.status)) return NextResponse.json({ item: batch, settled: { failed: 0, not_issued: 0 }, already: true });
  if (batch.status === "Cancelled") throw new HttpError(409, "A cancelled batch cannot be completed.");
  if (!["Active", "Closing"].includes(batch.status)) throw new HttpError(409, `A batch in ${batch.status} has not started yet — start it before completing it.`);

  const o = await outstanding(id);

  // QA-697 (-206, checker on qa-204): this used to write every unmarked student to Fail, derive the
  // sign-offs, walk the batch Active -> Closing, and only THEN meet Rule 18 on the final step and
  // throw 409. The Fail rows were permanent, the batch had already moved, and the caller saw an
  // error that named none of it. The checker reproduced it twice, at 10 and 12 rows; 166 students
  // across four live batches were standing in front of that button. Nothing is written now until
  // the whole press is known to be able to finish.
  //
  // The shape is Umesh's, 23/08: "2 time confirmation kindaa... ek popup aana chaiye like list of
  // critical issues in the batch remaining... and their navigation button to respective tab so that
  // they can fix those issues and vha prr neeche button of complete batch forcefully."
  // So the FIRST press never writes: without `force`, this refuses and names what is open. The
  // screen turns that into the list with a way to go and fix each one. Only a second, deliberate
  // press carries `force: true`.
  const force = body.force === true;
  const noCan = await enrolledWithoutCan(id);
  // QA-737: the same test the preview applies - a portal-ID gap under an already-signed
  // certification is not a door, and refusing a first press over it told the operator to go fix
  // something that was not stopping anything.
  const preClosure = await Closure.findOne({ batch: id }).select("certification_status").lean<any>();
  const canBlocks = (preClosure?.certification_status ?? "Pending") !== "Completed";
  const blockers = [
    ...o.unmarked.map((u) => ({ kind: "no result recorded", who: u.name ?? "(unnamed)", phone: u.phone ?? null, tab: "Candidates" })),
    ...o.unsettled.map((c) => ({ kind: "passed, certificate not settled", who: c.name ?? "(unnamed)", phone: c.phone ?? null, tab: "Closure" })),
    ...(canBlocks ? noCan.map((n) => ({ kind: "no portal Candidate ID", who: n.name || "(unnamed)", phone: n.phone ?? null, tab: "Closure" })) : []),
  ];
  if (blockers.length && !force) {
    const counts = [
      o.unmarked.length ? `${o.unmarked.length} with no result` : null,
      o.unsettled.length ? `${o.unsettled.length} passed with no certificate settled` : null,
      canBlocks && noCan.length ? `${noCan.length} with no portal Candidate ID` : null,
    ].filter(Boolean).join(", ");
    throw new HttpError(409,
      `This batch still has ${counts}. Nothing has been changed. Fix them, or complete the batch `
      + `forcefully - which records the reason and every one of these against the batch.`);
  }

  // QA-752 (-213, checker on qa-212): the blocker list above is built from the ACTIVE roster, so on
  // a batch where every member has been dropped it is EMPTY - no unmarked, no unsettled, no missing
  // portal ID - and an unforced press sailed past this refusal, wrote, moved the batch, and only
  // then met Rule 18, which needs a roster to derive assessment from. The comment three paragraphs
  // up promises "the FIRST press never writes"; on this shape it wrote. An empty list of blockers is
  // not the same fact as a batch that is ready, and this is the difference between the two.
  if (!force && (await activeRoster(id)).length === 0) {
    throw new HttpError(409,
      `Every student has been dropped from ${batch.code}, so there are no results to settle and `
      + `nothing has been changed. A batch in this state can only be completed forcefully, which `
      + `records who decided that and why.`);
  }

  const today = new Date();

  // 1. A student left unmarked when the Admin closes the batch is FAILED. Written through the
  //    ordinary marking door, so every guard that applies to a hand-typed result applies here too.
  //
  //    -204: this wrote "Absent" until Umesh was asked directly and chose otherwise (22/08, on the
  //    Gurugram batch): "jitne bachche remaining hain jinke certificate nahi hai, woh bachche fail
  //    ho gaye". He was shown the alternative in as many words - that a student who never sat the
  //    assessment is Absent, not Fail, and that the two are different facts on the client's sheet -
  //    and he was offered a split driven by attendance. He chose one word for all of them, and it is
  //    his record and his client. The distinction is not lost: the audit row below says the result
  //    was written by an Admin completing the batch, and names the reason they gave.
  //    Rule 44 refuses a Fail with no failure_reason, and it is right to: a fail nobody explained is
  //    useless to everyone downstream. The wall caught this the moment the result changed - eight
  //    assertions went red on "a Fail result requires a failure reason". So the reason is written
  //    too, and it says the true thing rather than a placeholder: this student was never marked, and
  //    the batch was completed anyway, by whom and why.
  for (const u of o.unmarked) {
    await upsertCandidateResult(id, u.member, {
      result: "Fail",
      assessed_on: today,
      failure_reason: `No result was recorded before ${batch.code} was completed by an Admin: ${reason}`,
    }, user.id);
    await audit({ entity: "BatchMember", entityId: u.member, field: "result",
      oldValue: "no result", newValue: `Fail — recorded by Admin completing ${batch.code}: ${reason}`, actor: user.id, actorType: "USER" });
  }

  // 2. A pass with no settled certificate is NOT ISSUED. This is the one place the Rule 46 ladder is
  //    stepped over rather than walked (Pending has no legal hop to Not Issued) — which is what an
  //    Admin override IS, and it is named on the row, not silent.
  for (const c of o.unsettled) {
    const row = await CandidateResult.findById(c.id);
    if (!row) continue;
    const was = row.certificate_status;
    row.certificate_status = "Not Issued";
    row.certificate_rejection_reason = `No certificate on record when the batch was completed by an Admin: ${reason}`;
    await row.save();
    await audit({ entity: "CandidateResult", entityId: row._id, field: "certificate_status",
      oldValue: was, newValue: `Not Issued — Admin completed ${batch.code} with no certificate for ${c.name ?? "this candidate"}: ${reason}`, actor: user.id, actorType: "USER" });
  }

  // 3. Now the ordinary rules can fire on their own: the sign-offs derive from the rows, and the
  //    batch walks its own ladder through the same doors the buttons use. Nothing is bypassed here.
  await recomputeClosureAggregates(id, user.id);

  // 3b. The portal Candidate ID is the one blocker the rows above cannot settle: it is a fact that
  //     lives on the government's side, and no amount of marking produces it. Rule 18 therefore
  //     holds certification shut, which is why this door used to reach its last step and 409.
  //     Umesh, 22/08: "Admin apne naam par band kar sake" - the rule stays, and an Admin may sign
  //     past it under their own name with a reason. `certification_derived` is set FALSE on purpose:
  //     a derived tick is a statement about the rows, and this one is not - it is a person's
  //     decision, and the audit row says so.
  //
  //     QA-735 / QA-736 (-212, checker on qa-211): this used to fire only `if (noCan.length)`, and
  //     that condition was WRONG about its own reason. The portal ID is not the only way
  //     certification stays Pending - `deriveCompletion` only signs certification when
  //     `pass_count > 0`, so a batch where NOBODY passed never derives it either. On such a batch,
  //     with no portal-ID gap at all, this override was skipped, the ladder below reached Rule 18,
  //     and the press 409'd - AFTER step 1 had written every unmarked student a permanent `Fail`
  //     and step 3 had moved the batch Active -> Closing. That is QA-697 restored in the release
  //     whose whole subject was a button that could only fail: the batch was left permanently
  //     un-completable while the drawer reported it clean. The -209 checker's reproduction passed
  //     only because its fixture happened to have a portal-ID gap.
  //
  //     So the condition is now the true one: on a FORCED press, if certification is still not
  //     Completed by this point, the Admin signs it - whatever the reason it did not derive - and
  //     the audit row names that actual reason rather than assuming the portal ID.
  //     QA-751 (-213, checker on qa-212): and it was still wrong, because certification is not the
  //     only arm. Rule 18 gates Active -> Closing on ASSESSMENT, and `deriveCompletion` signs
  //     assessment only when `total > 0` - so a roster where every member has been DROPPED never
  //     derives it either. On that shape -212 signed certification in the Admin's name, audit row
  //     and all, and then 409'd on the way out of Active: a batch stranded with a sign-off nobody
  //     could derive, the drawer calling it clean, and a second press repeating it forever. Third
  //     time this class has shipped. So BOTH arms are signed, by one rule, stated once.
  if (force) {
    //     QA-751 rider: on the all-dropped shape there may be NO closure document at all.
    //     `recomputeClosureAggregates` returns early with `legacy: true` when there are no result
    //     rows (rules.ts) - and on an empty active roster step 1 writes none - so nothing ever
    //     creates it. The wall caught this the moment the fixture actually dropped the members:
    //     my own QA-753 assertion fired with "no closure record exists for this batch", which is
    //     the guard doing its job and the fix being incomplete. Same idiom rules.ts already uses
    //     in two places, rather than a third spelling of "get or make the closure".
    const closureDoc = (await Closure.findOne({ batch: id })) ?? new Closure({ batch: id });
    {
      const rosterNow = await activeRoster(id);
      for (const arm of ["assessment", "certification"] as const) {
        const statusKey = `${arm}_status` as "assessment_status" | "certification_status";
        const derivedKey = `${arm}_derived`;
        const dateKey = `${arm}_date`;
        if ((closureDoc as any)[statusKey] === "Completed") continue;
        const why = arm === "assessment"
          ? (rosterNow.length === 0
            ? `no student remained on the roster, so assessment never derived on its own`
            : `assessment never derived on its own`)
          : (noCan.length
            ? `${noCan.length} enrolled student(s) still had no portal Candidate ID`
            : `no candidate passed, so certification never derived on its own`);
        const was = (closureDoc as any)[statusKey] ?? "Pending";
        (closureDoc as any)[statusKey] = "Completed";
        (closureDoc as any)[derivedKey] = false;
        if (!(closureDoc as any)[dateKey]) (closureDoc as any)[dateKey] = new Date();
        await closureDoc.save();
        await audit({ entity: "Closure", entityId: closureDoc._id, field: statusKey,
          oldValue: was,
          newValue: `Completed - signed by an Admin completing ${batch.code} while ${why}: ${reason}`,
          actor: user.id, actorType: "USER" });
      }
    }
  }

  // QA-736 / QA-753: the writes above are IRREVERSIBLE - permanent Fail rows and a status move.
  // Before the ladder can refuse and strand the batch half-settled, assert that the gates this door
  // is responsible for opening are actually open.
  //
  // QA-753 (-213, checker on qa-212): the -212 version of this assertion COULD NOT FIRE. It looked
  // only at certification - the one arm the block two lines above had just guaranteed - and its own
  // `signed &&` skipped it entirely when no Closure document existed. It guarded the only case that
  // was already safe, which is a guard-shaped version of the pin-that-cannot-fail. It reads BOTH
  // arms now, and a MISSING Closure is the loudest failure, not a silent pass.
  if (force) {
    const signed = await Closure.findOne({ batch: id }).select("assessment_status certification_status").lean<any>();
    const open = !signed
      ? ["no closure record exists for this batch"]
      : (["assessment", "certification"] as const)
        .filter((arm) => signed[`${arm}_status`] !== "Completed")
        .map((arm) => `${arm} is still ${signed[`${arm}_status`] ?? "Pending"}`);
    if (open.length) {
      throw new HttpError(500,
        `${batch.code}: the results were settled but the batch could NOT be completed - ${open.join(" and ")}. `
        + `The result rows written by this press stand. Reopen the batch and check the Closure tab `
        + `before pressing again.`);
    }
  }

  // QA-752 proper (-213, checker on qa-212): an UNFORCED press must not walk a ladder it cannot
  // finish. The shape: every student marked, NOBODY passed, no portal-ID gap. The blocker list is
  // EMPTY, so the refusal at the top of this door never fires. The press then settles nothing,
  // assessment derives on its own from the rows, the batch MOVES Active -> Closing, and only there
  // does Rule 18 refuse - because `deriveCompletion` signs certification only when pass_count > 0.
  // The batch is left one rung up from where the operator left it, by a press whose own comment
  // three paragraphs above promises "the FIRST press never writes". Measured against a rebuilt
  // -212: `Active -> Closing`, with the bare rule name as the message.
  //
  // An empty blocker list is not the same fact as a batch that can finish. So the arms are read
  // BEFORE the ladder, and a press that cannot reach Completed says so while nothing has moved.
  if (!force) {
    const arms = await Closure.findOne({ batch: id }).select("assessment_status certification_status").lean<any>();
    const open = (["assessment", "certification"] as const)
      .filter((arm) => (arms?.[`${arm}_status`] ?? "Pending") !== "Completed");
    if (open.length) {
      throw new HttpError(409,
        `${batch.code} cannot be completed yet - ${open.join(" and ")} ${open.length > 1 ? "are" : "is"} `
        + `not signed off, and nothing this press settles would change that. The batch has NOT been `
        + `moved. Complete it forcefully to sign off under your own name with a reason.`);
    }
  }

  const fresh = await Batch.findById(id).select("status").lean<any>();
  if (fresh?.status === "Active") await transitionBatch(id, "Closing", { isAdmin: true, reason, actor: user.id });
  // -226 (Umesh, 24/08): "humko puraane completed batch bhi tho system mai daalne hai." A batch being
  // entered months after it finished must be able to say WHEN it finished; without this the ladder
  // stamps today and the record is wrong at the far end forever (actual_end is no more editable than
  // actual_start was before -81). rules.ts holds the guards - not future, and never before the start.
  const done = await transitionBatch(id, "Completed", {
    isAdmin: true, reason, actor: user.id,
    ...(body.actual_end ? { actual_end: String(body.actual_end), backdate_override: true } : {}),
  });

  // 4. The record Umesh asked for: "logs and all proper bnte rahe ki batch complete kab kab hua and
  //    what all where the pending issues if the user had forcefully completed the batch along with
  //    date time... these date and time must should be in indian time zone IST".
  //    So the audit row carries WHAT was open at the moment of the press, not just how many, and the
  //    wall-clock in IST rather than the UTC instant the row is stored with - a completion time read
  //    off a server clock is the wrong time in every conversation anyone will have about it.
  const istStamp = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
  const pendingSummary = blockers.length
    ? blockers.map((b) => `${b.who} (${b.kind})`).join("; ")
    : "nothing was outstanding";
  await audit({ entity: "Batch", entityId: id, field: "completed_by_admin",
    newValue: `Completed by Admin at ${istStamp} IST - ${o.unmarked.length} student(s) recorded Fail, `
      + `${o.unsettled.length} certificate(s) Not Issued, ${noCan.length} without a portal Candidate ID. `
      + `Reason: ${reason}. Open at the time of the press: ${pendingSummary}`,
    actor: user.id, actorType: "USER" });
  return NextResponse.json({
    item: done,
    settled: { failed: o.unmarked.length, not_issued: o.unsettled.length, no_portal_id: noCan.length },
    forced: blockers.length > 0,
    completed_at_ist: istStamp,
  });
});
