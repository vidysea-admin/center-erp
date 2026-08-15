import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { assertBatchInScope, createDailyLogChecked } from "@/lib/rules";
import { audit } from "@/lib/audit";

// -82 (Umesh, 15/08): "batch ke andar Attendance tab se bhi us batch ki attendance fill karne
// ka option, that too bulk." The Attendance tab's grid posts many days in one call. Each day
// runs the SAME path as a single-day entry (createDailyLogChecked) — no rule is weaker for
// having arrived in bulk — and each day answers for itself: created | exists | error, so one
// bad day never blocks the others and the operator sees exactly which day said what.
// Body: { days: [{ log_date, present_member_ids: [], trainer_present?, biometric_member_ids?, note? }] }
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.daily_log");
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const body = await req.json();
  const days: any[] = Array.isArray(body?.days) ? body.days : [];
  if (!days.length) throw new HttpError(400, "days[] is required");
  if (days.length > 62) throw new HttpError(400, "At most 62 days per call.");
  const results: { log_date: string; status: "created" | "exists" | "error"; message?: string; id?: unknown }[] = [];
  for (const d of days) {
    const log_date = String(d?.log_date ?? "");
    try {
      const doc = await createDailyLogChecked(user, id, { ...d, log_date });
      results.push({ log_date, status: "created", id: doc._id });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      results.push({ log_date, status: /Rule 27/.test(msg) ? "exists" : "error", message: msg });
    }
  }
  const created = results.filter((r) => r.status === "created").length;
  await audit({ entity: "Batch", entityId: id, field: "attendance_bulk", newValue: `${created} day(s) marked in bulk (${results.length} requested)`, actor: user.id });
  return NextResponse.json({ created, results }, { status: created ? 201 : 200 });
});
