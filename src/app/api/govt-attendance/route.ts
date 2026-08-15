import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError } from "@/lib/authz";
import { requirePerm, requireView } from "@/lib/permissions";
import { GovtAttendanceImport, GovtAttendanceRow, Notification } from "@/models";
import { activateFromEvidence } from "@/lib/rules";
import { audit } from "@/lib/audit";
import {
  parseGovtAttendance, matchGovtRows, reconcileAgainstLogs, resolveLocationFromFile,
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
  // A scoped user only ever sees their own centres' imports.
  if (isScoped(user)) q.location = { $in: user.location_scope ?? [] };
  const items = await GovtAttendanceImport.find(q)
    .populate("location", "name external_id").populate("batch", "code")
    .populate("imported_by", "name")
    .sort({ imported_at: -1 }).limit(100).lean<any[]>();
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

  // The portal stamps the TC code into "Org Name", so the centre is usually self-evident; the
  // operator can still override it when a file spans centres or the code is missing.
  const auto = await resolveLocationFromFile(parsed);
  const locationId = String(form.get("location") || "") || auto?._id || null;
  if (!locationId && !batchId) {
    throw new HttpError(400, parsed.tc_id
      ? `No centre in the ERP carries TC ID "${parsed.tc_id}". Pick the centre manually, or set that TC ID on the location first.`
      : "This file carries no TC ID — pick the centre or batch manually.");
  }
  if (locationId && isScoped(user) && !(user.location_scope ?? []).map(String).includes(String(locationId))) {
    throw new HttpError(403, "That centre is outside your assigned locations.");
  }

  const matched = await reconcileAgainstLogs(await matchGovtRows(parsed.rows, { batchId, locationId }));
  const counts = {
    row_count: matched.length,
    matched_count: matched.filter((r) => r.match_status === "Matched").length,
    ambiguous_count: matched.filter((r) => r.match_status === "Ambiguous").length,
    unmatched_count: matched.filter((r) => r.match_status === "Unmatched").length,
    variance_count: matched.filter((r) => (r.variance_days ?? 0) !== 0).length,
  };

  if (!confirm) {
    return NextResponse.json({
      preview: matched.slice(0, 50), ...counts,
      skipped: parsed.skipped, org_name: parsed.org_name, tc_id: parsed.tc_id,
      resolved_location: auto ? { _id: auto._id, name: auto.name, external_id: auto.external_id } : null,
      header: parsed.header,
    });
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
  return NextResponse.json({ auto_activated: autoActivated,  _id: imp._id, ...counts }, { status: 201 });
});
