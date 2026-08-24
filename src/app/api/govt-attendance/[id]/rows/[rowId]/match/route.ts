import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError } from "@/lib/authz";
import { requirePerm, requireView } from "@/lib/permissions";
import { Batch, BatchMember, Candidate, DailyLog, GovtAttendanceImport, GovtAttendanceRow } from "@/models";
import { audit } from "@/lib/audit";
import { importInScope, isTrainerRow } from "@/lib/govt-attendance";

async function loadRow(id: string, rowId: string, user: Awaited<ReturnType<typeof requireUser>>) {
  const imp = await GovtAttendanceImport.findById(id).populate("location", "name").lean<any>();
  if (!imp) throw new HttpError(404, "Import not found");
  // Same fail-closed scope guard the GET/DELETE on this import use (QA-125 sweep), and the same
  // QA-830 repair: resolve the centre from the batch before concluding there is none, or the person
  // who uploaded the file cannot correct a single ambiguous row in it.
  if (isScoped(user) && !(await importInScope(user.location_scope ?? [], imp))) {
    throw new HttpError(403, "That import belongs to a centre outside your assigned locations.");
  }
  const row = await GovtAttendanceRow.findOne({ _id: rowId, import: id });
  if (!row) throw new HttpError(404, "That row is not part of this import.");
  return { imp, row };
}

// GET — what the operator needs in order to decide: the row exactly as the portal sent it, the
// importer's own reason for not deciding, and the candidates it could plausibly be. The ones that
// actually collided (same portal ID, or same name) come first and say why, because that IS the
// ambiguity Manish wanted to be able to click into.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string; rowId: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "attendance.govt");
  const { id, rowId } = await ctx.params;
  const { imp, row } = await loadRow(id, rowId, user);
  // -150 (QA-339): -148 stopped the WRITE from stamping a student onto a trainer's attendance row
  // and left this READ open, so the drawer still opened and offered four candidates on a row the
  // product had just said is not a student. Refusing at the write and inviting at the read is the
  // worse of the two states: it wastes an operator's decision and then rejects it.
  if (row.trainer || isTrainerRow(row)) {
    throw new HttpError(400, "That row is a trainer's attendance, not a candidate's - a trainer's hours are their own delivery record, so there is no student to pick.");
  }

  const nameKey = (s: unknown) => String(s ?? "").toLowerCase()
    .replace(/\b(mr|mrs|ms|md|shri|smt|kumari)\.?\s+/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

  let members: any[] = [];
  if (imp.batch) {
    members = await BatchMember.find({ batch: imp.batch })
      .populate("candidate", "name phone sidh_candidate_id").populate("batch", "code").lean<any[]>();
  } else if (imp.location) {
    const cands = await Candidate.find({ location: imp.location._id }).select("_id").lean<any[]>();
    const batchIds = await Batch.find({ location: imp.location._id }).distinct("_id");
    members = await BatchMember.find({ candidate: { $in: cands.map((c) => c._id) }, batch: { $in: batchIds } })
      .populate("candidate", "name phone sidh_candidate_id").populate("batch", "code").lean<any[]>();
  }

  const gid = String(row.govt_candidate_id ?? "").trim().toUpperCase();
  const nk = nameKey(row.name);
  const options = members
    .filter((m) => m.candidate)
    .map((m) => {
      const c = m.candidate;
      const sameId = !!gid && String(c.sidh_candidate_id ?? "").trim().toUpperCase() === gid;
      const sameName = !!nk && nameKey(c.name) === nk;
      return {
        candidate: c._id, name: c.name, phone: c.phone ?? null,
        sidh_candidate_id: c.sidh_candidate_id ?? null,
        batch: m.batch?.code ?? null, left_on: m.left_on ?? null,
        // -104: found by driving this drawer in a browser. Two same-name candidates with no portal
        // ID rendered as two IDENTICAL rows, so the one screen whose whole job is "pick the right
        // one" gave the operator nothing to pick on. The phone is the field that actually separates
        // them (it is required and unique per candidate), and the enrolment date is how a centre
        // register is usually ordered — which is exactly how Manish tells his two Sachins apart.
        joined_on: m.joined_on ?? null,
        enrollment_status: m.enrollment_status ?? null,
        collides: sameId ? "same portal ID" : sameName ? "same name" : null,
      };
    })
    .sort((a, b) => (a.collides ? 0 : 1) - (b.collides ? 0 : 1) || String(a.name).localeCompare(String(b.name)));

  return NextResponse.json({
    row, reason: row.match_note ?? null,
    scope: imp.batch ? "batch" : "centre",
    options,
    collisions: options.filter((o) => o.collides).length,
  });
});

// POST { candidate, reason? } — resolve an Ambiguous/Unmatched portal row onto one candidate.
//
// -102, Manish 17/08 ([11:21] "ambiguous name kaha se aa gaya, Sachin, Sachin, inki trainer ID alag
// hai… jab dono qualify kar hi chuke hain" · [11:34] "ambiguous name pe aisa hona chahiye ki wo click
// ho to uske baare me pata chal jaye ki kya issue hai" · [11:29] "usko hum manual bhi verify kar hi
// chuke hai"):
//
// The importer is deliberately conservative — two roster candidates sharing a name or a portal ID
// come back Ambiguous rather than guessed at (`matchGovtRows`, lib/govt-attendance.ts). That is the
// right call, but until now the only way out was to go and edit the candidate master by hand and
// re-import the file, and the row's own note said so. The operator has already checked the register
// and knows which student it is; this is that answer, written down and audited, with the same
// reconciliation the importer performs so the row is indistinguishable from an automatic match
// apart from `match_by: "Manual"` — which is exactly the provenance an auditor needs.
//
// An import is otherwise immutable (a wrong file is deleted and re-imported): what is written here
// is not the portal's data, only which ERP record it belongs to.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string; rowId: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "attendance.govt");
  const { id, rowId } = await ctx.params;

  const { imp, row } = await loadRow(id, rowId, user);
  // -148 (QA-332): `row.trainer` is only set when the importer MATCHED a trainer record, so this
  // guard missed the exact row that needed it - a trainer the ERP has never heard of, which stores
  // as Unmatched with no trainer set, and which -146 then invited an operator to link. The portal's
  // own type column is the test (-127 settled this for the assessment verdict; it is the same
  // question). Checked BEFORE the body is read, so a bad call cannot half-run.
  if (row.trainer || isTrainerRow(row)) {
    throw new HttpError(400, "That row is a trainer's attendance, not a candidate's - a trainer's hours are their own delivery record, so there is no student to link it to.");
  }

  const { candidate, reason } = await req.json().catch(() => ({}));
  if (!candidate) throw new HttpError(400, "Pick the candidate this portal row belongs to.");

  // The candidate must be on the roster this import covers — batch when the import is
  // batch-scoped, otherwise any batch at the import's centre. Anything else and a portal row
  // could be pinned onto a student who was never in the cohort.
  const memberQuery: Record<string, unknown> = { candidate };
  if (imp.batch) memberQuery.batch = imp.batch;
  const member = await BatchMember.find(memberQuery)
    .populate("candidate", "name sidh_candidate_id")
    .populate({ path: "batch", select: "code location" })
    .sort({ createdAt: -1 }).lean<any[]>()
    .then((ms) => imp.batch ? ms[0] : ms.find((m) => String(m.batch?.location) === String(imp.location?._id)) ?? null);
  if (!member) {
    throw new HttpError(400, imp.batch
      ? "That candidate is not on this batch's roster, so this portal row cannot belong to them."
      : "That candidate is not enrolled in any batch at this centre.");
  }

  // Same reconciliation the importer runs (reconcileAgainstLogs): our own logged days for this
  // member, and the variance the portal's figure creates against them.
  const internal = await DailyLog.countDocuments({ batch: member.batch?._id ?? member.batch, present_member_ids: member._id });
  const was = { status: row.match_status, by: row.match_by, note: row.match_note, candidate: row.candidate ? String(row.candidate) : null };

  row.candidate = member.candidate?._id ?? member.candidate;
  row.batch = member.batch?._id ?? member.batch;
  row.batch_member = member._id;
  row.match_status = "Matched";
  row.match_by = "Manual";
  row.match_note = `Resolved by ${user.name}${reason ? ` — ${String(reason).trim()}` : ""} (was ${was.status}${was.note ? `: ${was.note}` : ""})`;
  row.internal_days_present = internal;
  row.variance_days = row.total_days_present == null ? null : row.total_days_present - internal;
  await row.save();

  // The summary counts on the import are stored, so they are re-derived rather than left stale —
  // an "8 ambiguous" chip that no longer matches its own rows is how a screen starts lying.
  const [matched, unmatched, ambiguous, variance] = await Promise.all([
    GovtAttendanceRow.countDocuments({ import: id, match_status: "Matched" }),
    GovtAttendanceRow.countDocuments({ import: id, match_status: "Unmatched" }),
    GovtAttendanceRow.countDocuments({ import: id, match_status: "Ambiguous" }),
    GovtAttendanceRow.countDocuments({ import: id, variance_days: { $nin: [0, null] } }),
  ]);
  await GovtAttendanceImport.updateOne({ _id: id },
    { $set: { matched_count: matched, unmatched_count: unmatched, ambiguous_count: ambiguous, variance_count: variance } });

  // -137 (G-02): the resolve used to write the ROW and stop, which left a deadlock in place.
  // matchGovtRows tries the portal ID first and falls back to name; the ID branch can only see
  // candidates that already carry sidh_candidate_id, and every automatic writer of that field
  // refuses to act on an ambiguous match — correctly, because an identity field must never be
  // written off a guess. So two same-name candidates with no portal ID could never self-heal: the
  // same file re-imported went Ambiguous again, every time, forever.
  //
  // A HUMAN choosing is not a guess, and that is the whole difference. This is the one place in the
  // product where the ambiguity is resolved by a person who looked at both rows, so it is the one
  // place allowed to stamp the ID. Guarded exactly as the importer's own write-back is
  // (api/govt-attendance/route.ts:136-139): only when the row carries an ID, and NEVER over one the
  // candidate already has — a stored government ID is identity data and is not ours to overwrite.
  const stampId = String(row.govt_candidate_id ?? "").trim();
  const candId = member.candidate?._id ?? member.candidate;
  if (stampId && candId) {
    const res = await Candidate.updateOne(
      { _id: candId, $or: [{ sidh_candidate_id: null }, { sidh_candidate_id: "" }, { sidh_candidate_id: { $exists: false } }] },
      { $set: { sidh_candidate_id: stampId } },
    );
    if (res.modifiedCount) {
      await audit({
        entity: "Candidate", entityId: candId, field: "sidh_candidate_id",
        oldValue: "", newValue: stampId,
        actor: user.id, actorType: "USER",
      });
    }
  }

  await audit({
    entity: "GovtAttendanceRow", entityId: row._id, field: "match",
    oldValue: `${was.status}${was.by ? ` by ${was.by}` : ""}`,
    newValue: `Matched to ${member.candidate?.name ?? candidate} manually by ${user.name}${reason ? ` — ${String(reason).trim()}` : ""}`,
    actor: user.id, actorType: "USER",
  });

  return NextResponse.json({
    item: row,
    candidate_name: member.candidate?.name ?? null,
    counts: { matched, unmatched, ambiguous, variance },
  });
});
