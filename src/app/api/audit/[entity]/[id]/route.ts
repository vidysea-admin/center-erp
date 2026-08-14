import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, isScoped, assertLocationInScope, HttpError } from "@/lib/authz";
import { AuditLog, Batch, BatchMember, Candidate, CandidateResult, DailyLog, Location, Closure, Invoice, Room, Trainer, TrainerRequest } from "@/models";

// Which field on each entity carries the location it belongs to. An entity that is not
// location-bound (Program, User, Defaults…) is deliberately absent and fails closed for
// scoped users. A resolver may return a LIST of location ids for entities whose scope is a
// multi-field union (QA-137: Trainer joined so its History tab works for scoped users —
// same nominated/home/capable union as the list and item routes since QA-125).
const LOCATION_OF: Record<string, (id: string) => Promise<string | string[] | null | undefined>> = {
  Location: async (id) => id,
  Trainer: async (id) => {
    const t = await Trainer.findById(id).select("nominated_for_location home_location capable_locations").lean<any>();
    if (!t) return null;
    return [t.nominated_for_location, t.home_location, ...(t.capable_locations ?? [])].filter(Boolean).map(String);
  },
  Room: async (id) => (await Room.findById(id).select("location").lean<any>())?.location,
  Candidate: async (id) => (await Candidate.findById(id).select("location").lean<any>())?.location,
  Batch: async (id) => (await Batch.findById(id).select("location").lean<any>())?.location,
  TrainerRequest: async (id) => (await TrainerRequest.findById(id).select("location").lean<any>())?.location,
  BatchMember: async (id) => {
    const m = await BatchMember.findById(id).select("batch").lean<any>();
    return m && (await Batch.findById(m.batch).select("location").lean<any>())?.location;
  },
  DailyLog: async (id) => {
    const l = await DailyLog.findById(id).select("batch").lean<any>();
    return l && (await Batch.findById(l.batch).select("location").lean<any>())?.location;
  },
  Closure: async (id) => {
    const c = await Closure.findById(id).select("batch").lean<any>();
    return c && (await Batch.findById(c.batch).select("location").lean<any>())?.location;
  },
  Invoice: async (id) => {
    const i = await Invoice.findById(id).select("batch").lean<any>();
    return i && (await Batch.findById(i.batch).select("location").lean<any>())?.location;
  },
  CandidateResult: async (id) => {
    const r = await CandidateResult.findById(id).select("batch").lean<any>();
    return r && (await Batch.findById(r.batch).select("location").lean<any>())?.location;
  },
};

// Activity feed for any entity (read-only).
// 2026-08-12 audit (auth S1-5): this route carried requireUser() alone, so any signed-in user —
// including a view-only account scoped to one centre — could read the full audit trail of any
// record in the database by id, and the trail stores before/after values, so it leaked the very
// personal data Rule 38 exists to scope.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ entity: string; id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { entity, id } = await ctx.params;

  if (isScoped(user)) {
    const resolver = LOCATION_OF[entity];
    if (!resolver) throw new HttpError(403, "Out of scope"); // unknown entity: fail closed
    const locationId = await resolver(id);
    if (locationId == null) throw new HttpError(404, entity + " not found");
    if (Array.isArray(locationId)) {
      // Union scope (Trainer): pass if ANY tie is in scope; an untied record fails closed,
      // consistent with the QA-125 list/item behaviour.
      const allowed = (user.location_scope ?? []).map(String);
      if (!locationId.some((l) => allowed.includes(String(l)))) throw new HttpError(403, "Out of scope");
    } else {
      assertLocationInScope(user, String(locationId)); // Rule 38
    }
  }

  const items = await AuditLog.find({ entity, entity_id: id }).sort({ created_at: -1 }).limit(200).populate("actor", "name").lean();
  return NextResponse.json({ items });
});
