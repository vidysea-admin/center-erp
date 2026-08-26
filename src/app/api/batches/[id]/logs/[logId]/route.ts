import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, DailyLog } from "@/models";
import { assertBatchInScope } from "@/lib/rules";
import { audit } from "@/lib/audit";
import { removeStoredFile } from "@/lib/storage";

// -98 (QA-165, checker 16/08): a daily log could never be deleted — DELETE was 405 and there was no
// single-log read. A wrong day, wrong attendance, wrong video: nothing could be undone, not even by
// an Admin. Delete is the same right that creates a log (batches.daily_log + edit + batch scope),
// refuses on a frozen batch (Completed / Cancelled — its figures are recorded), is AUDITED with the
// full snapshot of what left (date, present count, evidence URLs, reason), and takes the day's own
// evidence objects out of storage with it (rows kept as the audit trail, URLs answer 410).

const params = async (ctx: { params: Promise<{ id: string; logId: string }> }) => {
  const { id, logId } = await ctx.params;
  if (!/^[a-f0-9]{24}$/.test(logId)) throw new HttpError(400, "Bad log id");
  return { id, logId };
};

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string; logId: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id, logId } = await params(ctx);
  await assertBatchInScope(user, id); // Rule 38
  const item = await DailyLog.findOne({ _id: logId, batch: id }).populate("entered_by", "name").lean();
  if (!item) throw new HttpError(404, "Daily log not found on this batch.");
  return NextResponse.json({ item });
});

export const DELETE = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string; logId: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.daily_log");
  const { id, logId } = await params(ctx);
  await assertBatchInScope(user, id); // Rule 38
  const batch = await Batch.findById(id).select("status code").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  if (batch.status === "Completed" || batch.status === "Cancelled") throw new HttpError(409, `This batch is ${batch.status} — its days are recorded and frozen; a daily log cannot be deleted now.`);
  const log = await DailyLog.findOne({ _id: logId, batch: id });
  if (!log) throw new HttpError(404, "Daily log not found on this batch.");
  let reason = "";
  try { const b = await req.json(); reason = String(b?.reason ?? "").trim().slice(0, 300); } catch { /* no body is fine */ }
  const snapshot = {
    log_date: log.log_date, present: (log.present_member_ids ?? []).length, govt_present: log.govt_present ?? null,
    photos: log.photos ?? [], videos: log.videos ?? [], attendance_sheet: log.attendance_sheet ?? [], govt_screenshot: log.govt_screenshot ?? null,
    note: log.note ?? null, entered_by: String(log.entered_by ?? ""),
  };
  await log.deleteOne();
  // the day's own evidence leaves with it (best-effort; each row stays as audit, URL → 410)
  const files = [...snapshot.photos, ...snapshot.videos, ...snapshot.attendance_sheet, ...(snapshot.govt_screenshot ? [snapshot.govt_screenshot] : [])];
  const removed: string[] = [];
  for (const u of files) { const r = await removeStoredFile(String(u), user.id).catch(() => ({ removed: false })); if (r.removed) removed.push(String(u).split("/").pop() ?? ""); }
  await audit({
    entity: "Batch", entityId: id, field: "daily_log_deleted",
    oldValue: JSON.stringify(snapshot).slice(0, 1500),
    newValue: `deleted by ${user.name}${reason ? ` — ${reason}` : ""}; ${removed.length}/${files.length} evidence file(s) removed from storage`,
    actor: user.id,
  });
  return NextResponse.json({ ok: true, deleted: logId, evidence_removed: removed.length, evidence_total: files.length });
});
