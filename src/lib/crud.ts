import { NextRequest, NextResponse } from "next/server";
import type { Model } from "mongoose";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, locationFilter, isScoped, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import type { SessionUser } from "@/auth";
import { audit, auditDiff } from "@/lib/audit";

type Role = SessionUser["role"];

export type CrudConfig = {
  model: Model<any>;
  entity: string;
  fields: string[]; // writable field whitelist
  searchFields?: string[];
  scopeField?: string | null; // Rule 38 — null disables location scoping
  // Rule 38 for entities whose "location" is not one field (trainers: nominated/capable/home).
  // Applied for scoped users as an AND-clause; return null to leave the user unscoped.
  scopeFilter?: (user: SessionUser) => Record<string, unknown> | null;
  writeRoles?: Role[]; // roles allowed to create/update (edit flag still applies)
  readRoles?: Role[]; // optional read restriction (Rule 40)
  // Togglable right required to READ. Reading and writing a screen are governed by the
  // same grant, so an Admin who grants every right does not leave screens mysteriously
  // closed (2026-08-12: found by testing a real account with all rights granted).
  readPermission?: string;
  // 2026-08-11 (CEO, AWS-style toggles): when set, writes are gated by this togglable
  // permission INSTEAD of the static writeRoles list — an Admin can grant it to anyone
  // or revoke it from a whole role. writeRoles remains the fallback when absent.
  permission?: string;
  populate?: { path: string; select?: string }[];
  defaultSort?: Record<string, 1 | -1>;
  beforeCreate?: (body: Record<string, unknown>, user: SessionUser) => Promise<void> | void;
  beforeUpdate?: (id: string, body: Record<string, unknown>, existing: any, user: SessionUser) => Promise<void> | void;
  afterWrite?: (doc: any, user: SessionUser) => Promise<void> | void;
  // Optional read-side decorator: attach computed fields to items before they leave the API.
  mapItems?: (items: any[], user: SessionUser) => Promise<any[]> | any[];
  // QA-125: itemRoutes never supported scopeFilter, so an entity whose scope is a
  // multi-field union (trainers) had LIST scoping and zero item scoping. This hook runs
  // on GET (after load) and PATCH (before write) with the loaded record — throw 403 to
  // refuse. Use alongside scopeField: null.
  scopeAssert?: (user: SessionUser, item: any) => void;
};

export function pick(body: Record<string, unknown>, fields: string[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

async function checkWrite(user: SessionUser, cfg: CrudConfig) {
  requireEdit(user); // Rule 39
  if (cfg.permission) {
    await requirePerm(user, cfg.permission);
    return;
  }
  if (cfg.writeRoles && !cfg.writeRoles.includes(user.role)) {
    throw new HttpError(403, `Only ${cfg.writeRoles.join("/")} may modify ${cfg.entity}.`);
  }
}

export function collectionRoutes(cfg: CrudConfig) {
  const GET = apiHandler(async (req: NextRequest) => {
    await dbConnect();
    const user = await requireUser();
    if (cfg.readPermission) await requirePerm(user, cfg.readPermission);
    else if (cfg.readRoles) requireRole(user, ...cfg.readRoles);
    const sp = req.nextUrl.searchParams;
    const filter: Record<string, unknown> = {};
    const scopeField = cfg.scopeField ?? "location";
    // Client-supplied filters are restricted to known fields and applied BEFORE the location
    // scope. Previously any ?key=value was copied in after the scope filter, so ?location=<other
    // centre> simply overwrote Rule 38 and exposed every centre's candidate PII (audit F-000),
    // and $-prefixed keys reached mongod as query operators.
    const filterable = new Set([...cfg.fields, ...(cfg.scopeField === null ? [] : [scopeField])]);
    for (const [k, v] of sp.entries()) {
      if (["q", "page", "limit", "sort"].includes(k) || !v) continue;
      if (k.startsWith("$") || k.includes(".")) throw new HttpError(400, `Unsupported filter "${k}".`);
      if (!filterable.has(k)) continue; // unknown key: ignored, never a Mongo filter
      filter[k] = v === "null" ? null : v;
    }
    // Rule 38 last, so a client filter can narrow within scope but never widen past it.
    if (cfg.scopeField !== null && isScoped(user)) {
      const allowed = (user.location_scope ?? []).map(String);
      const requested = filter[scopeField];
      if (requested === undefined || !allowed.includes(String(requested))) {
        Object.assign(filter, locationFilter(user, scopeField));
      }
    }
    // Multi-field scoping (2026-08-13, Umesh: a Jaipur-scoped principal saw ALL trainers) —
    // an AND-clause so it can carry its own $or without colliding with the search $or below.
    if (cfg.scopeFilter && isScoped(user)) {
      const f = cfg.scopeFilter(user);
      if (f) filter.$and = [...((filter.$and as unknown[]) ?? []), f];
    }
    const q = sp.get("q");
    if (q && cfg.searchFields?.length) {
      // Escape regex metacharacters — raw user input reached $regex, so ?q=( was a 500.
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = cfg.searchFields.map((f) => ({ [f]: { $regex: esc, $options: "i" } }));
    }
    const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
    // 2026-08-13, Umesh: "don't apply any capping — full scale banana hai." The 200 ceiling was
    // silently hiding 372 of 572 candidates. 5000 is a guard against a runaway query, not a
    // product limit; DataTable paginates client-side, and `total` is always returned.
    // Sanitize before the ceiling: parseInt("abc")→NaN and limit=0 both make mongo's
    // .limit() return the WHOLE collection, and a negative limit returns abs(n) rows
    // (maker-found M-02, 2026-08-14). Coerce to a positive integer, default 50, hard-capped.
    // QA-053: Number() not parseInt — parseInt stops at the first non-digit, so "1e9" and
    // "1.5" both became 1, silently returning a single row for a caller that asked for a
    // page. Number() reads them as 1e9 and 1.5; the ceil+clamp then does the right thing.
    const asked = Number(sp.get("limit") ?? "");
    const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(5000, Math.ceil(asked)) : 50;
    let query = cfg.model.find(filter).sort(cfg.defaultSort ?? { createdAt: -1 }).skip((page - 1) * limit).limit(limit);
    for (const p of cfg.populate ?? []) query = query.populate(p.path, p.select);
    let [items, total] = await Promise.all([query.lean(), cfg.model.countDocuments(filter)]);
    if (cfg.mapItems) items = await cfg.mapItems(items as any[], user);
    return NextResponse.json({ items, total, page, limit });
  });

  const POST = apiHandler(async (req: NextRequest) => {
    await dbConnect();
    const user = await requireUser();
    await checkWrite(user, cfg);
    const body = await req.json();
    const data = pick(body, cfg.fields);
    if (cfg.beforeCreate) await cfg.beforeCreate(data, user);
    const doc = await cfg.model.create({ ...data, created_by: user.id });
    await audit({ entity: cfg.entity, entityId: doc._id, field: undefined, newValue: "created", actor: user.id });
    if (cfg.afterWrite) await cfg.afterWrite(doc, user);
    return NextResponse.json({ item: doc }, { status: 201 });
  });

  return { GET, POST };
}

export function itemRoutes(cfg: CrudConfig) {
  const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await dbConnect();
    const user = await requireUser();
    if (cfg.readPermission) await requirePerm(user, cfg.readPermission);
    else if (cfg.readRoles) requireRole(user, ...cfg.readRoles);
    const { id } = await ctx.params;
    let query = cfg.model.findById(id);
    for (const p of cfg.populate ?? []) query = query.populate(p.path, p.select);
    let item = await query.lean<any>();
    if (!item) throw new HttpError(404, cfg.entity + " not found");
    if (cfg.scopeField !== null && isScoped(user)) {
      const locVal = item[cfg.scopeField ?? "location"];
      const locId = typeof locVal === "object" && locVal?._id ? locVal._id : locVal;
      // Fail closed: a record with no scope value is NOT visible to a scoped user.
      if (!locId || !user.location_scope.map(String).includes(String(locId))) {
        throw new HttpError(403, "Out of scope");
      }
    }
    if (cfg.scopeAssert) cfg.scopeAssert(user, item); // QA-125: multi-field union scope
    if (cfg.mapItems) item = (await cfg.mapItems([item], user))[0];
    return NextResponse.json({ item });
  });

  const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await dbConnect();
    const user = await requireUser();
    await checkWrite(user, cfg);
    const { id } = await ctx.params;
    const existing = await cfg.model.findById(id);
    if (!existing) throw new HttpError(404, cfg.entity + " not found");
    if (cfg.scopeField !== null && isScoped(user)) {
      const locId = existing[cfg.scopeField ?? "location"]; // Rule 38 on by-ID writes
      // Fail closed: an unscoped record is not writable by a scoped user either.
      if (!locId || !user.location_scope.map(String).includes(String(locId))) {
        throw new HttpError(403, "Out of scope");
      }
    }
    if (cfg.scopeAssert) cfg.scopeAssert(user, existing); // QA-125: multi-field union scope
    const body = await req.json();
    const data = pick(body, cfg.fields);
    if (cfg.beforeUpdate) await cfg.beforeUpdate(id, data, existing, user);
    const before = existing.toObject();
    Object.assign(existing, data);
    // validateModifiedOnly: sheet-imported rows (raw-driver seed) can lack required fields the
    // user is not touching — full-document validation would 400 a plain phone correction on them.
    await existing.save({ validateModifiedOnly: true });
    await auditDiff(cfg.entity, existing._id, before, data, user.id); // audit each field (Rule 27 spirit)
    if (cfg.afterWrite) await cfg.afterWrite(existing, user);
    return NextResponse.json({ item: existing });
  });

  return { GET, PATCH };
}
