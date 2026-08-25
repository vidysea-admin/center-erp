import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError } from "@/lib/authz";
import { requirePerm, requireView } from "@/lib/permissions";
import { BatchMember, Candidate, GovtAttendanceImport, GovtAttendanceRow, Notification } from "@/models";
import { activateFromEvidence } from "@/lib/rules";
import { audit } from "@/lib/audit";
import {
  parseGovtAttendance, matchGovtRows, reconcileAgainstLogs, resolveLocationFromFile, shiftSignature, portalIdKey,
  importLocationForWrite, scopedImportOr,
} from "@/lib/govt-attendance";

// Government portal attendance (2026-08-12). The boss's ask was that Manish uploads the portal
// export "in whatever format" and the system reads it and matches it to our own records. Upload
// is two-step on purpose — preview first, commit second — because an unmatched row means a
// candidate the portal knows and we do not, and that is a data problem to look at, not to
// silently swallow.

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "attendance.govt") /* QA-025 P3: read = view */;
  const q: Record<string, unknown> = {};
  const batch = req.nextUrl.searchParams.get("batch");
  const location = req.nextUrl.searchParams.get("location");
  if (batch) q.batch = batch;
  if (location) q.location = location;
  // A scoped user only ever sees their own centres' imports. QA-830: this used to OVERWRITE
  // q.location with the scope, so an import stored with location:null - which the write below
  // allowed - could never match, and the uploader's own import was invisible to them. The scope is
  // an $and now, so an explicit ?location= still narrows and the scope still authorises.
  if (isScoped(user)) {
    q.$and = [{ $or: await scopedImportOr(user.location_scope ?? []) }];
  }
  const items = await GovtAttendanceImport.find(q)
    .populate("location", "name external_id").populate("batch", "code")
    .populate("imported_by", "name")
    .sort({ imported_at: -1 }).limit(100).lean<any[]>();
  // -143 (QA-300, checker's PARTIAL on -142): the Variance column on THIS list is the surface an
  // operator meets first and every time - not the upload preview, which is seen once while
  // committing. It printed a bold amber count for imports whose every row reads "OUR DAYS 0 / 0".
  // Derived here rather than stored: have_local_logs is a question about the rows, and storing it
  // on the import is what silently failed before (it is not on the schema, so create() dropped it).
  const withLogs = items.length
    ? await GovtAttendanceRow.aggregate([
        { $match: { import: { $in: items.map((i) => i._id) }, internal_days_present: { $gt: 0 } } },
        { $group: { _id: "$import" } },
      ])
    : [];
  const haveLogs = new Set(withLogs.map((r) => String(r._id)));
  for (const it of items) it.have_local_logs = haveLogs.has(String(it._id));
  return NextResponse.json({ items });
});

// POST multipart: file, [batch], [location], [period_label], confirm ("1" to write)
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "attendance.govt");

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) throw new HttpError(400, "file is required");
  const batchId = String(form.get("batch") || "") || null;
  const confirm = form.get("confirm") === "1";
  const periodLabel = String(form.get("period_label") || "").trim();

  let parsed;
  try {
    parsed = parseGovtAttendance(Buffer.from(await file.arrayBuffer()), file.name);
  } catch (e: unknown) {
    throw new HttpError(400, e instanceof Error ? e.message : "Could not read this file.");
  }
  if (!parsed.rows.length) throw new HttpError(400, "The file has a header but no attendance rows.");

  // -154 (QA-438, S1): the shifted-column signature, checked BEFORE anything is written.
  //
  // Measured on live 20-08 (Umesh, column against column, not a story about the file): a 24-row
  // export landed whose days-attended figures sat in the WORKING-DAYS field - 24 of 24 rows had
  // new.total_working_days == old.total_days_present and total_days_present null on every row,
  // with hours in decimals where every genuine file is HH:MM:SS. It imported silently, its rows
  // became the newest matched rows, and two students who had genuinely cleared the 60-hour bar
  // (Laxman Singh 67:16:14, Mukesh Kumar 63:26:42) read as not_eligible off figures the
  // government never asserted. "Newest import wins" is the right rule; a misread file wearing
  // the newest timestamp is how it lies.
  //
  // BOTH halves are required, deliberately. A genuinely empty days-present column happens (a
  // brand-new batch), and a file spanning two batches can honestly carry two working-day figures
  // - either alone must not trip this. Together - days-present empty on ~every row while
  // working-days VARIES per student, where a real export carries one batch-level figure - they
  // are the signature of columns that have slipped.
  // -155: the signature moved to lib (shiftSignature) so the health screen and the ID-re-match
  // read the SAME test instead of growing near-copies - the drift that cost 55 portal IDs.
  const sig = shiftSignature(parsed.rows);
  const dpEmpty = sig.days_present_empty;
  const wdDistinct = sig.distinct_working_days;
  const columnShiftSuspected = sig.suspected;
  const acceptShift = form.get("accept_column_shift") === "1";

  // The portal stamps the TC code into "Org Name", so the centre is usually self-evident; the
  // operator can still override it when a file spans centres or the code is missing.
  const auto = await resolveLocationFromFile(parsed);
  // QA-830: when neither the file nor the operator names a centre, take the BATCH's. `Batch.location`
  // is required, so this always resolves - and it is what stops -223 onwards from writing another
  // record that its own uploader can never reach.
  const locationId = await importLocationForWrite(
    String(form.get("location") || "") || (auto?._id ? String(auto._id) : null),
    batchId ? String(batchId) : null,
  );
  if (!locationId && !batchId) {
    throw new HttpError(400, parsed.tc_id
      ? `No centre in the ERP carries TC ID "${parsed.tc_id}". Pick the centre manually, or set that TC ID on the location first.`
      : "This file carries no TC ID — pick the centre or batch manually.");
  }
  if (locationId && isScoped(user) && !(user.location_scope ?? []).map(String).includes(String(locationId))) {
    throw new HttpError(403, "That centre is outside your assigned locations.");
  }

  const matched = await reconcileAgainstLogs(await matchGovtRows(parsed.rows, { batchId, locationId }));
  // -248 (QA-1217 / QA-416, Umesh 25/08). A row that CARRIES a portal Candidate ID and was still
  // placed by NAME is the case this gate is about. It is not an error — matching by name is how a
  // roster that has never held portal IDs gets linked at all, and -108 deliberately kept it — but
  // it is a GUESS made on a string that repeats within every centre, and until now it was committed
  // in silence. Umesh's Chitrakoot export carries two "Sandeep Kumar" rows under different IDs.
  //
  // Derived, never stored: no new match_status, no schema change, and a legacy export with no
  // Candidate ID column does not trip it (portalIdKey of nothing is null). Cycle 2 (QA-1226): this
  // asks "does this row CARRY an id", and with the bare `normalizeCan` a row carrying an unreadable
  // `CAN_ED…` answered no — so the one row shape most likely to fall to a name match was the one
  // shape the gate stayed silent about. The contradiction case
  // is NOT here — matchGovtRows refuses that outright, because nobody can consent to overruling an
  // ID already on record.
  const nameMatchedRows = matched.filter(
    (r) => r.match_status === "Matched" && r.match_by === "Name" && portalIdKey(r.govt_candidate_id),
  );
  const nameMatchSuspected = nameMatchedRows.length > 0;
  const acceptNameMatch = form.get("accept_name_match") === "1";
  const counts = {
    row_count: matched.length,
    matched_count: matched.filter((r) => r.match_status === "Matched").length,
    ambiguous_count: matched.filter((r) => r.match_status === "Ambiguous").length,
    unmatched_count: matched.filter((r) => r.match_status === "Unmatched").length,
    variance_count: matched.filter((r) => (r.variance_days ?? 0) !== 0).length,
    // -142 (QA-300, 19/08 recording): "35 differ from our logs" is technically true and practically
    // meaningless when the ERP holds NO logs to differ from — the batch header says "Our logs: 0
    // days", every candidate reads "OUR DAYS 0 / 0", and the variance column is the portal's own
    // figure copied across with a + sign. Nothing is being compared. The count stays (a caller may
    // want it), but the screens now know whether there was anything on our side at all, so an
    // orange warning does not send somebody looking for a discrepancy that cannot exist.
    // -143: this one is for the PREVIEW only, which has no stored rows to ask yet. It is NOT a
    // schema field, so create() below drops it - which is correct now that both other surfaces
    // derive it from the rows at read time instead of hoping it was stored (QA-300).
    have_local_logs: matched.some((r) => (r.internal_days_present ?? 0) > 0),
    // QA-897 (Umesh 24/08: "attandance upload kaam nhi krr rha hai properly"). On a batch with NO
    // students every STUDENT row comes back Unmatched — matchGovtRows builds its candidate index
    // from this batch's members (:357) and there are none — so the screen reads like the upload
    // failed. It did not fail; there is nobody to match against yet. Saying so is the difference
    // between an operator fixing the roster and an operator re-uploading the same file expecting a
    // different answer. Costs one count, and only when a batch was named.
    //
    // The first version of this said "nothing can match" and that was FALSE, caught by this unit's
    // own control pin returning matched_count 1 on an empty batch. Trainer lookup at :401 is
    // deliberately GLOBAL (-149/QA-334, -151/QA-350 argued and kept it), so a trainer row matches
    // whatever the roster holds. Hence a second count: the claim the screen makes is about STUDENTS,
    // so the number the screen is allowed to lean on has to be about students too.
    //
    // QA-897 → QA-1030 → QA-1041: the same sentence was wrong three times, each time one layer
    // down, and the third one is the reason there are now TWO flags instead of one.
    //
    // The screen was asking a single boolean to answer two different questions:
    //   (a) can a student row in this file match ANYTHING here?  — that is the matcher's index,
    //       which is `{batch}` with no left_on filter (govt-attendance.ts:359)
    //   (b) does this batch have anybody on it right now?        — that is REQ-119's roster,
    //       `{batch, left_on: null}`, the definition `rules.ts:385 rosterOnDate` uses and the one
    //       eleven other counts in this codebase use
    // One boolean can only get one of those right. QA-1030 was (a) answered with (b)'s count;
    // e239139 flipped it to (b) answered with (a)'s count, and the checker caught that the lie had
    // simply changed sides: a batch everyone had LEFT, whose file names none of them, went back to
    // blaming the portal Candidate ID — on a batch its own screen was calling empty in the same
    // breath. Fixing a false sentence by making a different one false is not a fix.
    //
    // So: both counts, from one read, and the screen picks the message. `roster_is_empty` keeps the
    // matcher's meaning (nothing here can EVER match); `roster_all_departed` carries the other case,
    // which needs its own sentence because neither of the existing two is true in it.
    ...(await (async () => {
      if (!batchId) return { roster_is_empty: false, roster_all_departed: false };
      const rosterRows = await BatchMember.find({ batch: batchId }).select("left_on").lean<any[]>();
      return {
        roster_is_empty: rosterRows.length === 0,
        roster_all_departed: rosterRows.length > 0 && rosterRows.every((m) => m.left_on),
      };
    })()),
    matched_student_count: matched.filter((r) => r.match_status === "Matched" && !r.trainer).length,
  };

  if (!confirm) {
    return NextResponse.json({
      preview: matched.slice(0, 50), ...counts,
      skipped: parsed.skipped, org_name: parsed.org_name, tc_id: parsed.tc_id,
      resolved_location: auto ? { _id: auto._id, name: auto.name, external_id: auto.external_id } : null,
      header: parsed.header,
      // -106: which expected columns this file does not carry, so a blank column on the grid is
      // explained BEFORE the import is committed rather than looking like missing data.
      missing_columns: parsed.missing_columns,
      hours_parsed: matched.filter((m) => m.total_hours_minutes != null).length,
      // -108 follow-up (checker, 17/08): the write-back's evidence is a NAME match — that is
      // unavoidable, because a row matched on the portal ID means the candidate already has it. So
      // the honest answer is consent before the write, not a stricter rule that would make the
      // feature do nothing: the operator sees WHO is about to receive a permanent government ID and
      // on what evidence, and can walk away. Ambiguous rows are absent from this list by
      // construction — matchGovtRows never stamps one.
      portal_ids_to_link: matched.filter((r) => r.stamp_candidate_id).map((r) => ({
        name: r.name, id: r.stamp_candidate_id, matched_by: r.match_by,
      })),
      // -154 (QA-438): named on the PREVIEW, where the operator still has the file open in front
      // of them - not discovered three hours later in a qualified count that moved down.
      column_shift_suspected: columnShiftSuspected,
      ...(columnShiftSuspected ? { column_shift_detail: {
        rows: parsed.rows.length, days_present_empty: dpEmpty,
        distinct_working_days: wdDistinct.slice(0, 12),
      } } : {}),
      // -248 (QA-1217 / QA-416): named on the PREVIEW with the portal ID beside the name, because
      // the ID is the thing the operator has to look at to decide - the name is what is in doubt.
      name_match_suspected: nameMatchSuspected,
      ...(nameMatchSuspected ? { name_match_detail: {
        count: nameMatchedRows.length,
        rows: nameMatchedRows.slice(0, 50).map((r) => ({
          name: r.name, id: r.govt_candidate_id, sl_no: r.sl_no ?? null,
        })),
      } } : {}),
    });
  }

  // -154 (QA-438): the commit gate. Same shape as the candidate import's mis-mapped-phone gate
  // (the report stays a report; the WRITE waits for an explicit, informed confirmation) - the
  // operator is never trapped, but a silent pass is exactly what put two qualified students below
  // the bar on 20-08.
  // -248 (QA-1217 / QA-416, Umesh 25/08: "candidate id ke basis par wo karna chahiye, otherwise
  // issue aata rahega"). Same shape as the column-shift gate directly below: the report stays a
  // report, the WRITE waits for an informed confirmation. Checked FIRST because it is the one Umesh
  // raised, and because a file can trip both.
  //
  // The remedies are named because "match them by ID instead" is not actionable on its own - the
  // operator has to be told WHERE the ID goes. Both doors already exist: the candidate import maps a
  // "Portal candidate ID" column (field-catalog.ts, CANDIDATE_IMPORT_FIELDS), and the batch screen
  // has "Link portal IDs" for rosters whose IDs this system already holds on earlier imports.
  if (nameMatchSuspected && !acceptNameMatch) {
    const sample = nameMatchedRows.slice(0, 5).map((r) => `${r.name} (${r.govt_candidate_id})`).join(", ");
    throw new HttpError(400,
      `${nameMatchedRows.length} of ${matched.length} rows carry a portal Candidate ID, but no candidate here holds that ID - so they were placed by NAME instead: ${sample}${nameMatchedRows.length > 5 ? `, and ${nameMatchedRows.length - 5} more` : ""}. Names repeat within a centre, so each of those is a guess. Put the IDs on the candidates first - the candidate import reads a "Portal candidate ID" column, and the batch screen's "Link portal IDs" fills in the ones this system already holds - then import again and they will match on the ID. If you have checked the register yourself and these are right, confirm the checkbox on the preview and import again.`);
  }

  if (columnShiftSuspected && !acceptShift) {
    throw new HttpError(400,
      `This file looks column-shifted: ${dpEmpty} of ${parsed.rows.length} rows have nothing in "Total Days Present" while "Total Working days" differs per student (${wdDistinct.slice(0, 6).join(", ")}${wdDistinct.length > 6 ? ", …" : ""}) - a genuine export carries ONE working-day figure for the whole batch. This is the layout that read two qualified students as below the 60-hour bar on 20-08. Check the file's columns before importing; if it really is right, confirm the checkbox on the preview and import again.`);
  }

  const imp = await GovtAttendanceImport.create({
    location: locationId, batch: batchId,
    file_name: file.name, org_name: parsed.org_name, tc_id: parsed.tc_id,
    period_label: periodLabel || file.name.replace(/\.(csv|xlsx?)$/i, ""),
    ...counts, imported_by: user.id,
  });
  await GovtAttendanceRow.insertMany(matched.map((r) => ({
    import: imp._id, location: locationId, batch: r.batch ?? batchId,
    candidate: r.candidate, trainer: r.trainer, batch_member: r.batch_member,
    sl_no: r.sl_no, org_name: r.org_name, tc_id: r.tc_id, attendance_id: r.attendance_id,
    name: r.name, govt_candidate_id: r.govt_candidate_id,
    candidate_type: r.candidate_type, designation: r.designation,
    total_working_days: r.total_working_days, total_days_present: r.total_days_present,
    total_hours_minutes: r.total_hours_minutes, total_hours_raw: r.total_hours_raw,
    average_per_day_raw: r.average_per_day_raw, not_closed: r.not_closed,
    match_status: r.match_status, match_by: r.match_by, match_note: r.match_note,
    internal_days_present: r.internal_days_present ?? null, variance_days: r.variance_days ?? null,
  })));

  await audit({
    entity: "GovtAttendanceImport", entityId: imp._id, field: "import",
    newValue: `${counts.row_count} rows from ${file.name} — ${counts.matched_count} matched, ${counts.unmatched_count} unmatched, ${counts.variance_count} with a day-count variance`,
    actor: user.id,
  });

  // -108: carry the portal ID back onto the candidate. This is the missing write that made every
  // one of Manish's correctly-named certificates fail — the certificate matcher joins on
  // Candidate.sidh_candidate_id, and on the Gurugram roster not one of 39 had it, while the rows
  // being inserted right here already knew which CAN id belonged to which candidate.
  // Two guards, both deliberate: only rows the matcher resolved UNAMBIGUOUSLY carry a stamp
  // (matchGovtRows never sets it on an Ambiguous row), and the update is conditional on the field
  // still being empty — an id already on record is never overwritten by an import.
  let portal_ids_linked = 0;
  for (const r of matched) {
    if (!r.stamp_candidate_id || !r.candidate) continue;
    const res = await Candidate.updateOne(
      { _id: r.candidate, $or: [{ sidh_candidate_id: null }, { sidh_candidate_id: "" }, { sidh_candidate_id: { $exists: false } }] },
      { $set: { sidh_candidate_id: r.stamp_candidate_id } },
    );
    if (res.modifiedCount) {
      portal_ids_linked++;
      await audit({
        entity: "Candidate", entityId: r.candidate, field: "sidh_candidate_id",
        oldValue: null, newValue: `${r.stamp_candidate_id} — linked from portal import ${imp.period_label} (matched by ${r.match_by})`,
        actor: user.id,
      });
    }
  }

  // -88 (Umesh): attendance on record = the batch is running. A Planning/Ready batch that
  // just received matched portal rows becomes Active on its own (audited); nobody is asked
  // to click Mark Ready / Start after the fact.
  const touchedBatches = [...new Set(matched.filter((r) => r.match_status === "Matched" && (r.batch ?? batchId)).map((r) => String(r.batch ?? batchId)))];
  const autoActivated: string[] = [];
  for (const bId of touchedBatches) {
    try { const res = await activateFromEvidence(bId, { actor: user.id, source: `portal import ${imp.period_label}` }); if (res.activated) autoActivated.push(bId); } catch { /* the import itself stands; activation is best-effort and audited when it happens */ }
  }

  // A variance is the number the client is invoiced on diverging from the number the centre
  // logged, so it is raised rather than left for someone to notice on the report.
  if (counts.variance_count || counts.unmatched_count) {
    await Notification.create({
      type: "govt_attendance_variance",
      severity: counts.variance_count ? "warning" : "info",
      message: `Portal attendance imported (${imp.period_label}): ${counts.variance_count} candidate(s) differ from our daily logs, ${counts.unmatched_count} not found in the ERP.`,
      entity: "GovtAttendanceImport", entity_id: imp._id,
      link: `/govt-attendance?import=${imp._id}`,
      role_target: ["Admin", "Operations"],
      location: locationId ?? undefined,
    });
  }
  return NextResponse.json({ auto_activated: autoActivated, portal_ids_linked, _id: imp._id, ...counts }, { status: 201 });
});
