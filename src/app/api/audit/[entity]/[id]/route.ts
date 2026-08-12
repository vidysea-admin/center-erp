import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, isScoped, assertLocationInScope, HttpError } from "@/lib/authz";
import { AuditLog, Batch, BatchMember, Candidate, CandidateResult, DailyLog, Location, Closure, Invoice, Room, TrainerRequest } from "@/models";

// Which field on each entity carries the location it belongs to. An entity that is not
// location-bound (Trainer, Program, User, Defaults…) is deliberately absent and stays
// readable by any signed-in user, exactly as the lists for those entities already are.
const LOCATION_OF: Record<string, (id: string) => Promise<string | null | undefined>> = {
  Location: async (id) => id,
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
    if (!locationId) throw new HttpError(404, entity + " not found");
    assertLocationInScope(user, String(locationId)); // Rule 38
  }

  const items = await AuditLog.find({ entity, entity_id: id }).sort({ created_at: -1 }).limit(200).populate("actor", "name").lean();
  return NextResponse.json({ items });
});
