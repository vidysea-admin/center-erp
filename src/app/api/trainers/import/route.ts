import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, isScoped } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { JobRole, Location, Program, Trainer, TRAINER_PIPELINE } from "@/models";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/duplicates";
import { canonicalPhone } from "@/lib/validate";

// F-TRAINER-IMPORT (2026-08-14): Manish's stage-wise trainer sheet (qa/templates #3)
// lands here — same 3-step shape as the candidates importer: upload → map → preview →
// confirm. Everything unresolvable is REPORTED and left blank, never guessed:
// unknown stages, unmatched centre/job-role names, Certified rows without a TR ID.
// POST multipart: file, mapping (JSON {excelCol: field}), confirm ("1" to write)

// 2026-08-14: the stored enum IS the CEO vocabulary now. Every legacy sheet/display value
// stays importable, remapped to the current stage it merged into — never guessed.
const STAGE_ALIASES: Record<string, string> = {
  "applied": "Fresh Lead",
  "cv reviewed": "Shortlisted",
  "shortlisted (for tot)": "Shortlisted",
  "shortlisted for tot": "Shortlisted",
  "cv review & shortlist (for tot)": "Shortlisted",
  "cv review & shortlist": "Shortlisted",
  "docs pending": "Shortlisted",
  "documents": "Shortlisted",
  "docs complete": "Documents Completed",
  "nomination prepared": "Documents Completed",
  "submitted to nsdc": "Sent to NSDC",
  "payment done": "TOT Payment Done",
  "ready to train": "Certified",
  "certified (ready to train)": "Certified",
  "certified ready to train": "Certified",
};
function resolveStage(raw: string): string | null {
  const k = raw.trim().toLowerCase();
  if (!k) return null;
  const enumHit = TRAINER_PIPELINE.find((s) => s.toLowerCase() === k);
  return enumHit ?? STAGE_ALIASES[k] ?? null;
}

const TEXT_FIELDS = ["name", "phone", "email", "qualification", "source", "tr_id", "home_location_other", "pipeline_note"];
const NUM_FIELDS = ["industry_experience_years", "teaching_experience_years", "day_rate"];

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "trainers.manage");
  const form = await req.formData();
  const file = form.get("file") as File | null;
  const confirm = form.get("confirm") === "1";
  const mappingRaw = form.get("mapping");
  if (!file) throw new HttpError(400, "file is required");

  const buf = Buffer.from(await file.arrayBuffer());
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length) throw new HttpError(400, "Sheet is empty");
  const columns = Object.keys(rows[0]);

  if (!mappingRaw) {
    return NextResponse.json({ columns, preview: rows.slice(0, 5), total: rows.length });
  }
  const mapping: Record<string, string> = JSON.parse(String(mappingRaw));
  const nameCol = Object.keys(mapping).find((c) => mapping[c] === "name");
  const phoneCol = Object.keys(mapping).find((c) => mapping[c] === "phone");
  if (!nameCol || !phoneCol) throw new HttpError(400, "Mapping must include name and phone");

  // 15/08 (Umesh): unknown columns are reported and, on accept, stored per row in
  // custom_fields under the sheet's own column name — never restricted away.
  const unknownCols = columns.filter((c) => !mapping[c]);
  const acceptUnknown = form.get("accept_unknown") === "1";

  // Name → id resolution for nominations, case-insensitive, exact. Ambiguity is unmatched.
  const [locs, progs, jobRoles] = await Promise.all([
    Location.find({}).select("name code operational_status").lean<any[]>(),
    Program.find({}).select("name code trainer_skill").lean<any[]>(),
    JobRole.find({ active: { $ne: false } }).select("name").lean<any[]>(),
  ]);
  // -132 (QA-281): the recognised job-role set, built exactly the way the trainer form builds it —
  // the JobRole master UNION the programmes' trainer_skill values (trainers/page.tsx:101-111). One
  // definition of "a role we know", so the importer and the form cannot disagree about it.
  const knownRoles = [...new Set([
    ...jobRoles.map((j) => String(j.name ?? "").trim()),
    ...progs.map((p) => String(p.trainer_skill ?? "").trim()),
  ].filter(Boolean))];
  // Word-set key: "Battery Repair System Technician" and "Battery System Repair Technician" have the
  // SAME words in a different order, which is precisely the failure that put one wrong string on eight
  // trainers in one second. Sorting the words finds that; a spelling mistake still will not match, and
  // should not — inventing a correction is worse than naming what we do not recognise.
  const wordKey = (v: string) => String(v).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
  const roleByWords = new Map<string, string>();
  for (const k of knownRoles) roleByWords.set(wordKey(k), k);
  const knownLower = new Set(knownRoles.map((k) => k.toLowerCase()));
  const locByName = new Map<string, any[]>();
  for (const l of locs) {
    const k = String(l.name).trim().toLowerCase();
    if (!locByName.has(k)) locByName.set(k, []);
    locByName.get(k)!.push(l);
  }
  const progByName = new Map<string, any[]>();
  for (const p of progs) {
    const k = String(p.name).trim().toLowerCase();
    if (!progByName.has(k)) progByName.set(k, []);
    progByName.get(k)!.push(p);
  }

  const stageUnmatched: string[] = [];
  const centreUnmatched: string[] = [];
  const roleUnmatched: string[] = [];
  const skillWarn: string[] = []; // -132 (QA-281): job-role values that named no known role
  const warnings: string[] = [];

  const trainers = rows
    .map((r) => {
      const t: Record<string, unknown> = { created_by: user.id };
      for (const [col, field] of Object.entries(mapping)) {
        const raw = String(r[col] ?? "").trim();
        if (TEXT_FIELDS.includes(field) && raw) t[field] = raw;
        if (NUM_FIELDS.includes(field) && raw && !isNaN(Number(raw))) t[field] = Number(raw);
        if (field === "skills" && raw) {
          // -132 (QA-281): this stored the column verbatim while the three fields BELOW it in this
          // same loop each resolved against real records and reported what did not match. That is how
          // "Battery Repair System Technician" was written onto eight trainers at 2026-08-17T08:04 —
          // one spreadsheet column, read once, never checked, against a master where the correct
          // spelling already existed on exactly one trainer.
          //
          // It WARNS and never blocks: -69 chose that deliberately and -128 reaffirmed it (a picker
          // over a master holding zero rows would refuse every real job role). But a warning that
          // names the near match is a different thing from a warning that says "unrecognised" — it
          // tells the person the row they meant already exists, which is the only way a second
          // spelling stops being created.
          const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
          t.skills = list;
          if (knownRoles.length) {
            for (const sk of list) {
              if (knownLower.has(sk.toLowerCase())) continue;
              const near = roleByWords.get(wordKey(sk));
              skillWarn.push(near
                ? `${t.name ?? r[nameCol] ?? "(no name)"}: skill "${sk}" is the same words as the existing job role "${near}" in a different order — imported as typed; fix it to "${near}" so both spellings do not exist`
                : `${t.name ?? r[nameCol] ?? "(no name)"}: skill "${sk}" matches no job role we know — imported as typed; add it to the job-roles master or correct the spelling`);
            }
          }
        }
        if (field === "pipeline_status" && raw) {
          const st = resolveStage(raw);
          if (st) t.pipeline_status = st;
          else stageUnmatched.push(raw);
        }
        if (field === "nominated_for_location" && raw) {
          const hits = locByName.get(raw.toLowerCase()) ?? [];
          if (hits.length === 1) {
            if (["On Hold", "Stopped", "Closed"].includes(String(hits[0].operational_status))) {
              warnings.push(`${t.name ?? r[nameCol]}: centre "${hits[0].name}" is ${hits[0].operational_status} — nomination left blank (F-B5: a halted centre does not hire)`);
            } else t.nominated_for_location = hits[0]._id;
          } else centreUnmatched.push(raw);
        }
        if (field === "nominated_for_program" && raw) {
          const hits = progByName.get(raw.toLowerCase()) ?? [];
          if (hits.length === 1) t.nominated_for_program = hits[0]._id;
          else roleUnmatched.push(raw);
        }
      }
      if (t.pipeline_status === "Certified" && !t.tr_id) {
        warnings.push(`${t.name ?? "(no name)"}: stage Certified but no TR ID — imported as-is, fix the TR ID in the ERP`);
      }
      if (acceptUnknown && unknownCols.length) {
        const cf: Record<string, string> = {};
        for (const col of unknownCols) {
          const raw = String(r[col] ?? "").trim();
          if (raw) cf[col] = raw.slice(0, 500);
        }
        if (Object.keys(cf).length) t.custom_fields = cf;
      }
      return t;
    })
    .filter((t) => t.name && t.phone);

  // QA-141 (Umesh): canonicalize what we can, REPORT what we cannot — rows are never dropped
  // over format, but a valid-shaped number lands as the bare 10 digits so the unique index
  // sees one person once (and the existing-directory check below actually matches).
  const phoneInvalid: string[] = [];
  for (const t of trainers) {
    const p = canonicalPhone(t.phone);
    if (p) t.phone = p;
    else phoneInvalid.push(`${t.name} (${t.phone})`);
  }

  // Phone-dedup, in-file and against the directory. Unlike candidates, a trainer's
  // phone is UNIQUE in the schema — a duplicate cannot be "flagged but imported", it
  // would bounce off the index. Duplicates are excluded from the insert and each one
  // is named with why.
  // QA-125: a scoped importer only hires for their own centre(s) — a row nominating a
  // foreign centre is refused BY NAME, and every imported trainer is tied to the
  // importer's scope so their own list can see what they just imported.
  if (isScoped(user)) {
    const allowed = user.location_scope.map(String);
    for (const t of trainers) {
      if (t.nominated_for_location && !allowed.includes(String(t.nominated_for_location))) {
        warnings.push(`${t.name}: nominated centre is outside your scope — nomination left blank`);
        delete t.nominated_for_location;
      }
      t.capable_locations = user.location_scope;
    }
  }

  const seen = new Map<string, number>();
  const inFileDupe = new Set<number>();
  const duplicates: string[] = [];
  for (const [i, t] of trainers.entries()) {
    const key = normalizePhone(t.phone);
    if (!key) continue;
    if (seen.has(key)) {
      inFileDupe.add(i);
      duplicates.push(`${t.name} (${t.phone}) — same number as row ${seen.get(key)! + 1} in this file, skipped`);
    } else seen.set(key, i);
  }
  const existing = await Trainer.find({ phone: { $in: [...seen.keys()] } }).select("name phone").lean<any[]>();
  const existingPhones = new Set(existing.map((e) => normalizePhone(e.phone)));
  for (const e of existing) duplicates.push(`${e.name} (${e.phone}) — already in the trainer directory, skipped`);
  const importable = trainers.filter((t, i) => !inFileDupe.has(i) && !existingPhones.has(normalizePhone(t.phone)));

  const report = {
    valid: trainers.length,
    importable: importable.length,
    skipped: rows.length - trainers.length,
    duplicates: duplicates.slice(0, 25), duplicate_count: duplicates.length,
    stage_unmatched: [...new Set(stageUnmatched)].slice(0, 25),
    centre_unmatched: [...new Set(centreUnmatched)].slice(0, 25),
    role_unmatched: [...new Set(roleUnmatched)].slice(0, 25),
    // -132 (QA-281): the job-role warnings ride in the same list the operator already reads, rather
    // than a new field a caller has to know about. Deduped — one wrong spreadsheet column produces the
    // same sentence on every row it touched, and eight copies of it is noise, not information.
    warnings: [...warnings, ...new Set(skillWarn)].slice(0, 25),
    phone_invalid: phoneInvalid.slice(0, 25), phone_invalid_count: phoneInvalid.length,
    unknown_columns: unknownCols,
    // QA-110: say the quiet part — which columns are about to be DROPPED vs stored.
    ignored_columns: acceptUnknown ? [] : unknownCols,
    extra_columns_stored: acceptUnknown ? unknownCols : [],
  };
  if (!confirm) {
    return NextResponse.json({ preview: importable.slice(0, 10), ...report });
  }
  const docs = await Trainer.insertMany(importable);
  // Same 0-import bug FL10 caught on the batch importer: with every row skipped there is no
  // ObjectId to anchor the audit on, and "import" as an id 400'd the WHOLE response.
  if (docs[0]?._id) {
    await audit({ entity: "Trainer", entityId: docs[0]._id, field: "import", newValue: `${docs.length} imported, ${duplicates.length} duplicate flags${!acceptUnknown && unknownCols.length ? `, ${unknownCols.length} column(s) ignored: ${unknownCols.join(", ")}` : ""}`, actor: user.id });
  }
  return NextResponse.json({ imported: docs.length, ...report }, { status: 201 });
});
