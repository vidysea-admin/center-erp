import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Location, Program, SyncSource, TabMapping } from "@/models";
import { FIELD_CATALOG, fieldSpec, CatalogEntity } from "@/lib/field-catalog";
import { audit } from "@/lib/audit";

// Tab mappings — the user-approved column→field contracts the 5-minute watch ingests by.
// GET lists them (with each mapping's last run report); PUT approves/updates one.
// Gated sheet.sources like the rest of the source admin.

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.sources");
  const { id } = await ctx.params;
  const items = await TabMapping.find({ sync_source: id }).sort({ tab: 1 }).lean();
  return NextResponse.json({ items, catalog: FIELD_CATALOG });
});

export const PUT = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.sources");
  requireEdit(user);
  const { id } = await ctx.params;
  const src = await SyncSource.findById(id);
  if (!src) throw new HttpError(404, "Sync source not found");
  if (src.mode !== "watch") throw new HttpError(400, "Tab mappings ride on watch sources — this source is in mapped mode.");

  const body = await req.json();
  const entity = String(body.entity_type ?? "") as CatalogEntity;
  if (!FIELD_CATALOG[entity]) throw new HttpError(400, `entity_type must be one of: ${Object.keys(FIELD_CATALOG).join(", ")}`);
  const tab = String(body.tab ?? "").trim();
  if (!tab) throw new HttpError(400, "tab is required");

  const columns: { header: string; field: string }[] = (body.columns ?? [])
    .filter((c: any) => c?.header && c?.field)
    .map((c: any) => ({ header: String(c.header), field: String(c.field) }));
  const constants: Record<string, unknown> = body.constants ?? {};

  // Every mapped/constant field must exist in the catalog, and no field twice — a duplicate
  // means the later column silently wins, which is exactly the ambiguity this wizard exists to kill.
  const seen = new Set<string>();
  for (const c of columns) {
    if (!fieldSpec(entity, c.field)) throw new HttpError(400, `Unknown field "${c.field}" for ${entity}.`);
    if (seen.has(c.field)) throw new HttpError(400, `Field "${c.field}" is mapped from two columns — pick one.`);
    seen.add(c.field);
  }
  for (const f of Object.keys(constants)) {
    if (constants[f] === "" || constants[f] == null) { delete constants[f]; continue; }
    if (!fieldSpec(entity, f)) throw new HttpError(400, `Unknown constant field "${f}" for ${entity}.`);
    if (seen.has(f)) throw new HttpError(400, `Field "${f}" is both a column and a constant — pick one.`);
  }

  // Row identity must come from a mapped column (a constant key would collapse every row into one).
  const key_field = String(body.key_field ?? "");
  const keySpec = fieldSpec(entity, key_field);
  if (!keySpec?.keyable) throw new HttpError(400, `key_field must be one of: ${FIELD_CATALOG[entity].filter((f) => f.keyable).map((f) => f.key).join(", ")}`);
  if (!seen.has(key_field) || constants[key_field] !== undefined) throw new HttpError(400, `The key field "${key_field}" must be mapped from a column.`);

  // Required fields must be covered — by a column or a tab-level constant — or creation would
  // fail on every row and the "import" would be an empty promise.
  const uncovered = FIELD_CATALOG[entity].filter((f) => f.required && !seen.has(f.key) && constants[f.key] === undefined).map((f) => f.key);
  if (uncovered.length) throw new HttpError(400, `Required field(s) not covered by a column or constant: ${uncovered.join(", ")}. Map a column, or set a fixed value for this tab.`);

  // Constant FKs must point at real records — a typo here would mis-file every row of the tab.
  if (constants.location && !(await Location.exists({ _id: constants.location }))) throw new HttpError(400, "Constant location not found.");
  if (constants.program && !(await Program.exists({ _id: constants.program }))) throw new HttpError(400, "Constant program not found.");
  if (constants.home_location && !(await Location.exists({ _id: constants.home_location }))) throw new HttpError(400, "Constant home location not found.");

  const item = await TabMapping.findOneAndUpdate(
    { sync_source: src._id, tab },
    {
      $set: {
        entity_type: entity, columns, constants, key_field,
        active: body.active !== false,
        approved_by: user.id, approved_at: new Date(),
        initial_imported: false, // next watch run reprocesses the whole tab under the new contract
      },
    },
    { upsert: true, new: true },
  );
  await audit({ entity: "TabMapping", entityId: item._id, field: tab, newValue: `${entity} mapping approved (${columns.length} columns, key=${key_field})`, actor: user.id });
  return NextResponse.json({ item });
});
