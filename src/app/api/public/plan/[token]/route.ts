import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { Batch, PublicToken } from "@/models";
import { planArtifact, planExportRows } from "@/lib/rules";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";

// QA-152 part 2 (-82, Umesh): the plan opened from a shared link — "jaise self registration
// form open hota hai" — no login; the 32-hex token is the credential, same trust model as
// /p/attendance. The link holder READS; if the link was minted with allow_updates they may
// tick a milestone done/undone (recorded as done_via "link", no user id) — nothing else.
// ?format=xlsx hands the same plan over as an Excel file.
async function resolve(token: string) {
  const t = await PublicToken.findOne({ token, purpose: "plan", active: true }).lean<any>();
  if (!t?.batch) throw new HttpError(404, "This link is not valid or has been switched off.");
  return t;
}

export const GET = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
  await dbConnect();
  rateLimit("plan-read:" + clientKey(req), 60, 10 * 60_000); // own bucket — never eats the register route's
  const { token } = await ctx.params;
  const t = await resolve(token);
  const art = await planArtifact(String(t.batch));
  if (req.nextUrl.searchParams.get("format") === "xlsx") {
    const ws = XLSX.utils.json_to_sheet(planExportRows(art));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "plan");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="plan-${art.batch.code}.xlsx"`,
      },
    });
  }
  const { _id: _omit, ...batch } = art.batch as any;
  void _omit;
  return NextResponse.json({ ...art, batch, allow_updates: !!t.allow_updates });
});

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
  await dbConnect();
  rateLimit("plan-tick:" + clientKey(req), 30, 10 * 60_000);
  const { token } = await ctx.params;
  const t = await resolve(token);
  if (!t.allow_updates) throw new HttpError(403, "This link is read-only — ask the person who shared it for a link that allows status updates.");
  const body = await req.json().catch(() => ({}));
  const key = String(body.key ?? "");
  const batch = await Batch.findById(t.batch);
  if (!batch) throw new HttpError(404, "Batch not found");
  if (!batch.plan_enabled) throw new HttpError(409, "This batch has no plan.");
  if (["Completed", "Cancelled"].includes(batch.status)) throw new HttpError(409, "Batch is closed.");
  const m = (batch.milestones ?? []).find((x: any) => x.key === key);
  if (!m) throw new HttpError(404, "Milestone not found");
  if (body.done) { (m as any).done_on = new Date(); (m as any).done_by = undefined; (m as any).done_via = "link"; }
  else { (m as any).done_on = undefined; (m as any).done_by = undefined; (m as any).done_via = undefined; }
  batch.markModified("milestones");
  await batch.save();
  await audit({ entity: "Batch", entityId: batch._id, field: `milestone:${key}`, newValue: body.done ? "done (via shared link)" : "reopened (via shared link)", actorType: "SYSTEM" });
  const art = await planArtifact(String(t.batch));
  const { _id: _omit, ...b } = art.batch as any;
  void _omit;
  return NextResponse.json({ ...art, batch: b, allow_updates: true });
});
