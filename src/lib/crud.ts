import { NextRequest, NextResponse } from "next/server";
import type { Model } from "mongoose";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, locationFilter, HttpError } from "@/lib/authz";
import type { SessionUser } from "@/auth";
import { audit, auditDiff } from "@/lib/audit";

type Role = SessionUser["role"];

export type CrudConfig = {
  model: Model<any>;
  entity: string;
  fields: string[]; // writable field whitelist
  searchFields?: string[];
  scopeField?: string | null; // Rule 38 — null disables location scoping
  writeRoles?: Role[]; // roles allowed to create/update (edit flag still applies)
  readRoles?: Role[]; // optional read restriction (Rule 40)
  populate?: { path: string; select?: string }[];
  defaultSort?: Record<string, 1 | -1>;
  beforeCreate?: (body: Record<string, unknown>, user: SessionUser) => Promise<void> | void;
  beforeUpdate?: (id: string, body: Record<string, unknown>, existing: any, user: SessionUser) => Promise<void> | void;
  afterWrite?: (doc: any, user: SessionUser) => Promise<void> | void;
  // Optional read-side decorator: attach computed fields to items before they leave the API.
  mapItems?: (items: any[], user: SessionUser) => Promise<any[]> | any[];
};

export function pick(body: Record<string, unknown>, fields: string[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

function checkWrite(user: SessionUser, cfg: CrudConfig) {
  requireEdit(user); // Rule 39
  if (cfg.writeRoles && !cfg.writeRoles.includes(user.role)) {
    throw new HttpError(403, `Only ${cfg.writeRoles.join("/")} may modify ${cfg.entity}.`);
  }
}

export function collectionRoutes(cfg: CrudConfig) {
  const GET = apiHandler(async (req: NextRequest) => {
    await dbConnect();
    const user = await requireUser();
    if (cfg.readRoles) requireRole(user, ...cfg.readRoles);
    const sp = req.nextUrl.searchParams;
    const filter: Record<string, unknown> = {};
    if (cfg.scopeField !== null) Object.assign(filter, locationFilter(user, cfg.scopeField ?? "location"));
    // simple field filters: any ?field=value matching a writable/known field
    for (const [k, v] of sp.entries()) {
      if (["q", "page", "limit", "sort"].includes(k) || !v) continue;
      filter[k] = v === "null" ? null : v;
    }
    const q = sp.get("q");
    if (q && cfg.searchFields?.length) {
      filter.$or = cfg.searchFields.map((f) => ({ [f]: { $regex: q, $options: "i" } }));
    }
    const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
    const limit = Math.min(200, parseInt(sp.get("limit") || "50", 10));
    let query = cfg.model.find(filter).sort(cfg.defaultSort ?? { createdAt: -1 }).skip((page - 1) * limit).limit(limit);
    for (const p of cfg.populate ?? []) query = query.populate(p.path, p.select);
    let [items, total] = await Promise.all([query.lean(), cfg.model.countDocuments(filter)]);
    if (cfg.mapItems) items = await cfg.mapItems(items as any[], user);
    return NextResponse.json({ items, total, page, limit });
  });

  const POST = apiHandler(async (req: NextRequest) => {
    await dbConnect();
    const user = await requireUser();
    checkWrite(user, cfg);
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
    if (cfg.readRoles) requireRole(user, ...cfg.readRoles);
    const { id } = await ctx.params;
    let query = cfg.model.findById(id);
    for (const p of cfg.populate ?? []) query = query.populate(p.path, p.select);
    let item = await query.lean<any>();
    if (!item) throw new HttpError(404, cfg.entity + " not found");
    if (cfg.scopeField !== null && user.role === "Location") {
      const locVal = item[cfg.scopeField ?? "location"];
      const locId = typeof locVal === "object" && locVal?._id ? locVal._id : locVal;
      if (locId && !user.location_scope.map(String).includes(String(locId))) {
        throw new HttpError(403, "Out of scope");
      }
    }
    if (cfg.mapItems) item = (await cfg.mapItems([item], user))[0];
    return NextResponse.json({ item });
  });

  const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await dbConnect();
    const user = await requireUser();
    checkWrite(user, cfg);
    const { id } = await ctx.params;
    const existing = await cfg.model.findById(id);
    if (!existing) throw new HttpError(404, cfg.entity + " not found");
    if (cfg.scopeField !== null && user.role === "Location") {
      const locId = existing[cfg.scopeField ?? "location"]; // Rule 38 on by-ID writes
      if (locId && !user.location_scope.map(String).includes(String(locId))) {
        throw new HttpError(403, "Out of scope");
      }
    }
    const body = await req.json();
    const data = pick(body, cfg.fields);
    if (cfg.beforeUpdate) await cfg.beforeUpdate(id, data, existing, user);
    const before = existing.toObject();
    Object.assign(existing, data);
    await existing.save();
    await auditDiff(cfg.entity, existing._id, before, data, user.id); // audit each field (Rule 27 spirit)
    if (cfg.afterWrite) await cfg.afterWrite(existing, user);
    return NextResponse.json({ item: existing });
  });

  return { GET, PATCH };
}
