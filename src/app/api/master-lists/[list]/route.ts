import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { CostCategory, DropReason, FailureReason, JobRole, Scheme, SCHEME } from "@/models";

const LISTS: Record<string, any> = {
  "cost-categories": CostCategory, "drop-reasons": DropReason, "failure-reasons": FailureReason,
  // QA-118/119 (15/08): job roles and schemes become editable masters. The scheme rows
  // carry hours + money (Manish's data lands here; structure unblocks QA-093).
  "job-roles": JobRole, "schemes": Scheme,
};
// Per-list extra writable fields on top of name/active — everything else is dropped.
const EXTRA_FIELDS: Record<string, string[]> = {
  "schemes": ["code", "total_hours", "min_required_hours", "amount_received"],
  "job-roles": ["code"],
};

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ list: string }> }) => {
  await dbConnect();
  await requireUser();
  const { list } = await ctx.params;
  const Model = LISTS[list];
  if (!Model) throw new HttpError(404, "Unknown list");
  // Lazy seed: the scheme master mirrors the SCHEME enum so Program.scheme values always
  // have a row to hang their hours on — created once, empty of facts until Admin fills them.
  if (list === "schemes" && (await Scheme.countDocuments({})) === 0) {
    await Scheme.insertMany(SCHEME.map((name) => ({ name, active: true }))).catch(() => {});
  }
  const items = await Model.find({}).sort({ name: 1 }).lean();
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ list: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin"); // Rule 40
  const { list } = await ctx.params;
  const Model = LISTS[list];
  if (!Model) throw new HttpError(404, "Unknown list");
  const body = await req.json();
  const name = String(body.name ?? "").trim();
  if (!name) throw new HttpError(400, "name required");
  // F-B17 (2026-08-14): "Trainer Fee" and "Trainer fee" both existed in production and
  // the trainer-fee auto-suggest matched neither reliably. Names are unique per list,
  // case-insensitively — the refusal names the existing entry so the fix is obvious.
  const dupe = await Model.findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } }).lean();
  if (dupe) throw new HttpError(409, `"${dupe.name}" already exists in this list — names are unique (case-insensitive).`);
  const extras: Record<string, unknown> = {};
  for (const f of EXTRA_FIELDS[list] ?? []) {
    if (body[f] === undefined || body[f] === null || body[f] === "") continue;
    extras[f] = f === "code" ? String(body[f]).trim() : Number(body[f]);
    if (f !== "code" && !Number.isFinite(extras[f] as number)) throw new HttpError(400, `${f} must be a number`);
  }
  const item = await Model.create({ name, active: body.active ?? true, ...extras });
  return NextResponse.json({ item }, { status: 201 });
});
