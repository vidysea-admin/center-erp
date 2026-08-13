import * as XLSX from "xlsx";
import { Candidate, Location, Program, SheetChange, TabMapping, Trainer } from "@/models";
import { audit } from "@/lib/audit";
import {
  CatalogEntity, FIELD_CATALOG, FieldSpec, LocationLite, ProgramLite,
  fieldSpec, normHeader, parseSheetDate, phone10, coerceEducation, resolveLocation, resolveProgram,
} from "@/lib/field-catalog";

// The tab-mapping engine (2026-08-13). A TabMapping is a user-approved contract: "this tab's
// columns mean these fields; this field identifies a row." Under that contract, every watch run:
//   - creates entities for NEW keys (that is exactly what approving the mapping authorizes),
//   - turns changed values on EXISTING entities into SheetChange review items — a human OKs
//     each one before anything is overwritten, so a manual correction in the ERP can never be
//     silently clobbered by the sheet,
//   - names every row it could not place in last_report (report, never guess — the seed-script
//     discipline, now server-side).

const MODELS: Record<CatalogEntity, any> = { Candidate, Location, Trainer };

const S = (v: unknown) => String(v ?? "").trim();

export type ParsedRow = {
  rowNum: number; // 1-based sheet row for humans
  label: string; // best human name for the row
  data: Record<string, unknown>; // transformed, ready-to-write values
  display: Record<string, string>; // what the sheet said, for review items
  warnings: string[];
};

export type ParseContext = { locations: LocationLite[]; programs: ProgramLite[] };

function transform(spec: FieldSpec, raw: string, ctx: ParseContext): { value: unknown; warning?: string } {
  const v = S(raw);
  if (!v) return { value: undefined };
  switch (spec.type) {
    case "phone": {
      const p = phone10(v);
      return p ? { value: p } : { value: undefined, warning: `"${v}" is not a usable 10-digit phone` };
    }
    case "date": {
      const d = parseSheetDate(v);
      return d ? { value: d } : { value: undefined, warning: `"${v}" is not a readable date` };
    }
    case "dob": {
      // A bare "22" is an age (the registration tabs ask "What is your age?") — approximate DOB.
      if (/^\d{1,2}$/.test(v)) return { value: new Date(Date.UTC(new Date().getUTCFullYear() - Number(v), 0, 1)) };
      const d = parseSheetDate(v);
      return d ? { value: d } : { value: undefined, warning: `"${v}" is neither a date nor an age` };
    }
    case "number": {
      const n = parseFloat(v.replace(/[^\d.]/g, ""));
      return Number.isFinite(n) ? { value: n } : { value: undefined, warning: `"${v}" is not a number` };
    }
    case "list":
      return { value: v.split(/[,;/]+/).map((x) => x.trim()).filter(Boolean) };
    case "enum": {
      const exact = spec.enum?.find((e) => normHeader(e) === normHeader(v));
      if (exact) return { value: exact };
      if (spec.key === "education") {
        const e = coerceEducation(v);
        return e ? { value: e } : { value: undefined, warning: `education "${v}" not recognized` };
      }
      if (spec.key === "sidh_status" && /enrol|register/.test(normHeader(v))) return { value: "Registered" };
      const contains = spec.enum?.find((e) => normHeader(v).includes(normHeader(e)) || normHeader(e).includes(normHeader(v)));
      return contains ? { value: contains } : { value: undefined, warning: `"${v}" is not one of: ${spec.enum?.join(", ")}` };
    }
    case "fk_location": {
      const loc = resolveLocation(v, ctx.locations);
      return loc ? { value: loc._id } : { value: undefined, warning: `no centre matches "${v}"` };
    }
    case "fk_program": {
      const prog = resolveProgram(v, ctx.programs);
      return prog ? { value: prog._id } : { value: undefined, warning: `no program matches "${v}"` };
    }
    default:
      return { value: v };
  }
}

export type TabMappingSpec = {
  entity_type: CatalogEntity;
  columns: { header: string; field: string }[];
  constants: Record<string, unknown>;
  key_field: string;
};

export type ParsedTab = { header_row: number; header: string[]; rows: ParsedRow[]; error?: string };

// Header = the first row that carries every mapped column (normalized) — the client's tabs keep
// totals rows above the header, same tolerance as the mapped sync and the watch.
export function parseTab(sheet: XLSX.WorkSheet, tm: TabMappingSpec, ctx: ParseContext): ParsedTab {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false }) as string[][];
  const wanted = tm.columns.map((c) => normHeader(c.header));
  const headerRow = raw.slice(0, 10).findIndex((r) => {
    const cells = r.map((c) => normHeader(c));
    return wanted.every((w) => cells.includes(w));
  });
  if (headerRow < 0) {
    return { header_row: -1, header: [], rows: [], error: `No row in the first 10 carries all mapped columns (${tm.columns.map((c) => c.header).join(", ")}) — was a column renamed?` };
  }
  const header = (raw[headerRow] ?? []).map((h) => S(h));
  const idx = new Map<string, number>();
  header.forEach((h, i) => { if (h && !idx.has(normHeader(h))) idx.set(normHeader(h), i); });

  const rows: ParsedRow[] = [];
  for (let r = headerRow + 1; r < raw.length; r++) {
    const line = raw[r] ?? [];
    if (line.every((c) => S(c) === "")) continue;
    const data: Record<string, unknown> = {};
    const display: Record<string, string> = {};
    const warnings: string[] = [];
    for (const col of tm.columns) {
      const spec = fieldSpec(tm.entity_type, col.field);
      if (!spec) continue;
      const rawVal = S(line[idx.get(normHeader(col.header)) ?? -1]);
      const { value, warning } = transform(spec, rawVal, ctx);
      if (warning) warnings.push(warning);
      if (value !== undefined) { data[col.field] = value; display[col.field] = rawVal; }
    }
    // Tab-level facts (location/program of a per-district tab) fill in where no column did.
    for (const [field, value] of Object.entries(tm.constants ?? {})) {
      if (data[field] === undefined && value !== undefined && value !== "") data[field] = value;
    }
    const label = S(data.name) || S(data[tm.key_field]) || `row ${r + 1}`;
    rows.push({ rowNum: r + 1, label, data, display, warnings });
  }
  return { header_row: headerRow, header, rows };
}

function requiredMissing(entity: CatalogEntity, data: Record<string, unknown>): string[] {
  return FIELD_CATALOG[entity].filter((f) => f.required && (data[f.key] === undefined || data[f.key] === "")).map((f) => f.key);
}

function sameValue(spec: FieldSpec | undefined, oldV: unknown, newV: unknown): boolean {
  if (oldV == null && newV == null) return true;
  switch (spec?.type) {
    case "fk_location": case "fk_program":
      return String((oldV as any)?._id ?? oldV ?? "") === String(newV ?? "");
    case "date": case "dob":
      return String(oldV ? new Date(oldV as any).toISOString().slice(0, 10) : "") === String(newV ? new Date(newV as any).toISOString().slice(0, 10) : "");
    case "number":
      return Number(oldV ?? NaN) === Number(newV ?? NaN);
    case "list":
      return [...(Array.isArray(oldV) ? oldV : [])].join(",") === [...(Array.isArray(newV) ? newV : [])].join(",");
    default:
      return S(oldV) === S(newV);
  }
}

function displayOf(spec: FieldSpec | undefined, v: unknown, ctx: ParseContext): string {
  if (v == null) return "";
  if (spec?.type === "fk_location") return S(ctx.locations.find((l) => String(l._id) === String((v as any)?._id ?? v))?.name ?? v);
  if (spec?.type === "fk_program") return S(ctx.programs.find((p) => String(p._id) === String((v as any)?._id ?? v))?.name ?? v);
  if (spec?.type === "date" || spec?.type === "dob") return new Date(v as any).toISOString().slice(0, 10);
  return S(v);
}

export type TabMappingReport = {
  created: number; review: number; unchanged: number;
  skipped: string[]; // named rows, never silent
  error?: string;
};

// Runs inside the watch cycle: the workbook is already fetched, changedTabs says which tabs got a
// new snapshot this run. A mapping runs when its tab changed — or unconditionally until its first
// full import has happened.
export async function runTabMappings(src: any, wb: XLSX.WorkBook, changedTabs: Set<string>): Promise<number> {
  const mappings = await TabMapping.find({ sync_source: src._id, active: true });
  if (!mappings.length) return 0;
  const ctx: ParseContext = {
    locations: await Location.find({}).select("name district city").lean<any[]>(),
    programs: await Program.find({}).select("name code trainer_skill").lean<any[]>(),
  };
  let totalReview = 0;
  for (const tm of mappings) {
    if (tm.initial_imported && !changedTabs.has(tm.tab)) continue;
    const report: TabMappingReport = { created: 0, review: 0, unchanged: 0, skipped: [] };
    try {
      const sheet = wb.Sheets[tm.tab];
      if (!sheet) {
        report.error = `Tab "${tm.tab}" is not in the workbook — renamed or removed.`;
      } else {
        const parsed = parseTab(sheet, tm as any, ctx);
        if (parsed.error) report.error = parsed.error;
        else totalReview += await ingestRows(src, tm, parsed.rows, ctx, report);
      }
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
    }
    tm.last_report = report;
    tm.last_run_at = new Date();
    if (!report.error) tm.initial_imported = true;
    await tm.save();
  }
  return totalReview;
}

async function ingestRows(src: any, tm: any, rows: ParsedRow[], ctx: ParseContext, report: TabMappingReport): Promise<number> {
  const entity = tm.entity_type as CatalogEntity;
  const Model = MODELS[entity];
  const keySpec = fieldSpec(entity, tm.key_field);
  const normKey = (v: unknown) => (keySpec?.type === "phone" ? phone10(v) || S(v) : normHeader(v));

  // One query, normalized in memory — phone formats in the DB vary and the AVPL import used
  // NA-<name> placeholders where the sheet had no phone.
  const mappedFields = [...new Set([...tm.columns.map((c: any) => c.field), ...Object.keys(tm.constants ?? {}), tm.key_field, "name", "location", "home_location"])];
  const existingDocs = await Model.find({}).select(mappedFields.join(" "));
  const byKey = new Map<string, any>();
  for (const d of existingDocs) {
    const k = normKey(d[tm.key_field]);
    if (k && !byKey.has(k)) byKey.set(k, d);
  }

  let review = 0;
  for (const row of rows) {
    const keyRaw = row.data[tm.key_field];
    const key = normKey(keyRaw);
    if (!key) {
      report.skipped.push(`${row.label}: no ${tm.key_field}${row.warnings.length ? ` (${row.warnings.join("; ")})` : ""}`);
      continue;
    }
    const existing = byKey.get(key);

    if (!existing) {
      if (entity === "Location") {
        // Centres are contract entities — a mapping updates them but never invents one.
        report.skipped.push(`"${row.label}": no matching centre — locations are never auto-created`);
        continue;
      }
      const missing = requiredMissing(entity, row.data);
      if (missing.length) {
        report.skipped.push(`"${row.label}": missing ${missing.join(", ")}${row.warnings.length ? ` (${row.warnings.join("; ")})` : ""}`);
        continue;
      }
      try {
        const doc = await Model.create(row.data);
        byKey.set(key, doc);
        await audit({ entity, entityId: doc._id, newValue: `created from sheet tab "${tm.tab}" (${src.name})`, actorType: "EXTERNAL_SYNC" });
        report.created++;
      } catch (e) {
        report.skipped.push(`"${row.label}": ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }

    // Existing entity: every differing value becomes a review item, never a silent write.
    let changes = 0;
    for (const [field, value] of Object.entries(row.data)) {
      if (field === tm.key_field) continue;
      const spec = fieldSpec(entity, field);
      const oldV = existing[field];
      if (sameValue(spec, oldV, value)) continue;
      const newDisplay = row.display[field] ?? displayOf(spec, value, ctx);
      const dup = await SheetChange.findOne({ sync_source: src._id, entity: existing._id, field_name: field, new_value: newDisplay, status: "Open" }).lean();
      if (dup) { changes++; continue; } // already awaiting review
      const scopeLocation = entity === "Location" ? existing._id
        : entity === "Candidate" ? (row.data.location ?? existing.location)
        : (existing.home_location ?? undefined);
      await SheetChange.create({
        sync_source: src._id,
        tab: tm.tab,
        entity_type: entity,
        entity: existing._id,
        location: scopeLocation ?? undefined,
        field_name: field,
        old_value: displayOf(spec, oldV, ctx),
        new_value: newDisplay,
        // What "Apply value" writes and what Revert restores — resolved values, not sheet text.
        impact_snapshot: { row_label: row.label, apply: value, revert: oldV ?? "" },
      });
      review++; changes++;
    }
    if (!changes) report.unchanged++;
  }
  report.review = review;
  return review;
}
