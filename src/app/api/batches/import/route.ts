import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, Location, Program } from "@/models";
import { audit } from "@/lib/audit";
import { computePlannedEnd, createBatchWithCode, parseSheetDate } from "@/lib/rules";
import { readUploadedWorkbook } from "@/lib/workbook";

// Batch bulk import (QA-028's second half — "bulk upload in every module"). Batch_Master
// format: Centre + Job Role + Planned Start (+ Target Size, Session). Same contract as the
// candidate/trainer importers: upload → map → preview → confirm; a centre or job-role NAME
// that resolves to nothing (or to two things) is REPORTED and that row is skipped, never
// guessed. Codes are minted by the same counter the single-batch form uses; every imported
// batch carries the creator and the file it came from.
const SESSIONS = new Set(["Morning", "Afternoon", "Full Day"]);

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.manage");
  let form: FormData;
  try { form = await req.formData(); }
  catch { throw new HttpError(400, "multipart form-data body required — attach the sheet as 'file'"); }
  const file = form.get("file") as File | null;
  if (!file) throw new HttpError(400, "file is required");
  const confirm = form.get("confirm") === "1";
  const mappingRaw = form.get("mapping");

  const buf = Buffer.from(await file.arrayBuffer());
  // QA-1023: CSV date cells are coerced US-style at READ time; readUploadedWorkbook keeps them as
  // text so parseSheetDate can apply the template's own DD-MM-YYYY rule. See lib/workbook.ts.
  const wb = readUploadedWorkbook(buf, file.name);
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  if (!rows.length) throw new HttpError(400, "Sheet is empty");
  const columns = Object.keys(rows[0]);
  if (!mappingRaw) return NextResponse.json({ columns, preview: rows.slice(0, 5), total: rows.length });

  const mapping: Record<string, string> = JSON.parse(String(mappingRaw));
  const colFor = (field: string) => Object.keys(mapping).find((c) => mapping[c] === field);
  if (!colFor("location") || !colFor("program") || !colFor("planned_start")) {
    throw new HttpError(400, "Mapping must include location, program and planned_start");
  }

  // 15/08 (Umesh): unknown columns are reported and, on accept, stored per row in
  // custom_fields under the sheet's own column name — never restricted away.
  const unknownCols = columns.filter((c) => !mapping[c]);
  const acceptUnknown = form.get("accept_unknown") === "1";

  // Exact case-insensitive name resolution; an ambiguous name maps to null → reported.
  const byName = (docs: any[]) => {
    const m = new Map<string, any>();
    for (const d of docs) {
      const k = String(d.name).trim().toLowerCase();
      m.set(k, m.has(k) ? null : d);
    }
    return m;
  };
  // `code` rides along ON PURPOSE. nextBatchCode() takes the CENTRE CODE, and this select omitted
  // it — so `b.location.code` was undefined at the create below, nextBatchCode fell into its legacy
  // branch, and every bulk-imported batch got a `B###` code instead of CENTRE-PROGRAMME-NN. That
  // contradicted this file's own header ("Codes are minted by the same counter the single-batch form
  // uses") for a whole release, and the one assertion that would have caught it was a tautology
  // (e2e-flows-blindspot.mjs FL10). It is the identical mistake the comment on the next line already
  // records for Program — one line apart, same lesson, only one of them had been learned.
  const locByName = byName(await Location.find({}).select("name code approval_status operational_status").lean<any[]>());
  // Full program docs on purpose: computePlannedEnd needs duration_days + buffer_days, and a
  // partial select fed it undefined — planned_end cast to Invalid Date (caught by FL10).
  const progByName = byName(await Program.find({}).lean<any[]>());

  const location_unmatched: string[] = [];
  const program_unmatched: string[] = [];
  const skipped: string[] = [];
  const importable: any[] = [];
  for (const [i, r] of rows.entries()) {
    const locRaw = String(r[colFor("location")!] ?? "").trim();
    const progRaw = String(r[colFor("program")!] ?? "").trim();
    const startRaw = String(r[colFor("planned_start")!] ?? "").trim();
    if (!locRaw && !progRaw && !startRaw) continue; // blank spacer row
    const loc = locByName.get(locRaw.toLowerCase());
    const prog = progByName.get(progRaw.toLowerCase());
    if (!loc) { if (locRaw) location_unmatched.push(locRaw); skipped.push(`row ${i + 2}: centre "${locRaw || "(blank)"}" not recognised`); continue; }
    if (!prog) { if (progRaw) program_unmatched.push(progRaw); skipped.push(`row ${i + 2}: job role "${progRaw || "(blank)"}" not recognised`); continue; }
    // QA-097/098: same shared parser as the candidates importer — DD-MM-YYYY, ISO and
    // Excel serials all read; anything else is refused BY ROW, never guessed.
    const start = parseSheetDate(r[colFor("planned_start")!]);
    if (!start) { skipped.push(`row ${i + 2}: planned start "${startRaw}" is not a date`); continue; }
    const sizeCol = colFor("target_size");
    const sizeRaw = sizeCol ? Number(r[sizeCol]) : NaN;
    const sessCol = colFor("session");
    const sessRaw = sessCol ? String(r[sessCol] ?? "").trim() : "";
    if (sessRaw && !SESSIONS.has(sessRaw)) { skipped.push(`row ${i + 2}: session "${sessRaw}" must be Morning / Afternoon / Full Day`); continue; }
    const entry: any = {
      location: loc, program: prog, planned_start: start,
      target_size: Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : prog.default_batch_size,
      session: sessRaw || "Full Day",
    };
    if (acceptUnknown && unknownCols.length) {
      const cf: Record<string, string> = {};
      for (const col of unknownCols) {
        const raw = String(r[col] ?? "").trim();
        if (raw) cf[col] = raw.slice(0, 500);
      }
      if (Object.keys(cf).length) entry.custom_fields = cf;
    }
    importable.push(entry);
  }

  if (!confirm) {
    return NextResponse.json({
      valid: importable.length, skipped_count: skipped.length,
      skipped: skipped.slice(0, 25),
      location_unmatched: [...new Set(location_unmatched)].slice(0, 25),
      program_unmatched: [...new Set(program_unmatched)].slice(0, 25),
      unknown_columns: unknownCols,
      // QA-110: say the quiet part — which columns are about to be DROPPED vs stored.
      ignored_columns: acceptUnknown ? [] : unknownCols,
      extra_columns_stored: acceptUnknown ? unknownCols : [],
      preview: importable.slice(0, 10).map((b) => ({
        location: b.location.name, program: b.program.name,
        planned_start: b.planned_start, target_size: b.target_size, session: b.session,
      })),
    });
  }

  const created: string[] = [];
  let firstId: unknown = null;
  const refused: string[] = [];
  for (const b of importable) {
    try {
      assertLocationInScope(user, String(b.location._id));
      const end = computePlannedEnd(b.planned_start, {
        duration_days: b.program.duration_days ?? 0,
        buffer_days: b.program.buffer_days ?? 0,
      });
      // -225: minted inside, after validation. Before this, the number was taken as an ARGUMENT to
      // Batch.create, so EVERY row that ended up in `refused` below had already consumed one.
      const doc = await createBatchWithCode({
        location: b.location._id, program: b.program._id,
        session: b.session, target_size: b.target_size,
        planned_start: b.planned_start, planned_end: isNaN(end.getTime()) ? b.planned_start : end,
        milestones: [], plan_enabled: false, // QA-152 (-81): plan only on demand
        created_by: user.id,
        source: `Import: ${file.name}`,
        custom_fields: b.custom_fields,
      }, b.location, b.program);
      created.push(doc.code);
      if (!firstId) firstId = doc._id;
    } catch (e: any) {
      refused.push(`${b.location.name} × ${b.program.name}: ${e?.message ?? "create failed"}`);
    }
  }
  if (firstId) {
    await audit({ entity: "Batch", entityId: firstId, field: "import", newValue: `${created.length} batches imported from ${file.name} (${refused.length} refused, ${skipped.length} rows skipped${!acceptUnknown && unknownCols.length ? `, ${unknownCols.length} column(s) ignored: ${unknownCols.join(", ")}` : ""})`, actor: user.id });
  }
  return NextResponse.json({ created, refused, skipped_count: skipped.length, ignored_columns: acceptUnknown ? [] : unknownCols }, { status: 201 });
});
