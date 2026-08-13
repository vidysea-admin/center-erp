import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Location, Program, SyncSource } from "@/models";
import { fetchWorkbook } from "@/lib/workbook";
import { FIELD_CATALOG, suggestMapping, CatalogEntity } from "@/lib/field-catalog";
import { parseTab } from "@/lib/tab-mapping";

// The wizard's first screen: fetch the live workbook, find the tab's header, propose a
// column→field mapping from the catalog aliases, and parse a few rows under that proposal so the
// user sees exactly what would land — fuzzy centre matches, unreadable phones, all of it —
// BEFORE approving anything.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.sources");
  const { id } = await ctx.params;
  const src = await SyncSource.findById(id).lean<any>();
  if (!src) throw new HttpError(404, "Sync source not found");

  const body = await req.json();
  const entity = String(body.entity_type ?? "Candidate") as CatalogEntity;
  if (!FIELD_CATALOG[entity]) throw new HttpError(400, `entity_type must be one of: ${Object.keys(FIELD_CATALOG).join(", ")}`);

  const wb = await fetchWorkbook(src.source_url);
  const tab = String(body.tab ?? "");
  const sheet = wb.Sheets[tab];
  if (!sheet) throw new HttpError(400, `Tab "${tab}" is not in the workbook. Tabs: ${wb.SheetNames.join(", ")}`);

  // Densest of the first 10 rows — the client keeps totals rows above the real header.
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false }) as string[][];
  let headerRow = 0, best = -1;
  for (let i = 0; i < Math.min(raw.length, 10); i++) {
    const count = (raw[i] ?? []).filter((c) => String(c).trim() !== "").length;
    if (count > best) { best = count; headerRow = i; }
  }
  const header = (raw[headerRow] ?? []).map((h) => String(h).trim()).filter(Boolean);
  const suggestions = suggestMapping(header, entity);

  // Provisional spec from the suggestions → preview the first rows under it.
  const columns = suggestions.filter((s) => s.field).map((s) => ({ header: s.header, field: s.field as string }));
  const keyable = FIELD_CATALOG[entity].filter((f) => f.keyable).map((f) => f.key);
  const key_field = keyable.find((k) => columns.some((c) => c.field === k)) ?? keyable[0];
  const ctx2 = {
    locations: await Location.find({}).select("name district city").lean<any[]>(),
    programs: await Program.find({}).select("name code trainer_skill").lean<any[]>(),
  };
  const parsed = columns.length ? parseTab(sheet, { entity_type: entity, columns, constants: {}, key_field }, ctx2) : null;

  const covered = new Set(columns.map((c) => c.field));
  const required_missing = FIELD_CATALOG[entity].filter((f) => f.required && !covered.has(f.key)).map((f) => f.key);

  return NextResponse.json({
    tab, header, header_row: headerRow,
    suggestions, key_field, required_missing,
    row_count: parsed?.rows.length ?? Math.max(0, raw.length - headerRow - 1),
    preview: (parsed?.rows ?? []).slice(0, 8).map((r) => ({ label: r.label, data: r.display, warnings: r.warnings })),
    parse_error: parsed?.error,
    catalog: FIELD_CATALOG[entity],
  });
});
