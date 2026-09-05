import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError, readJson } from "@/lib/authz";
import { hasPermission, FINANCE_VIEW, maskCostCategoryMoneyList, requireFinance, COST_CATEGORY_MONEY_FIELDS } from "@/lib/permissions";
import type { SessionUser } from "@/auth";
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
  // QA-1828 (CEO): head → subhead → description, with the pre-approval rule on the head.
  "cost-categories": ["code", "parent", "description", "head_type", "budget", "pre_approved", "pre_approved_amount", "pre_approved_basis"],
};
// Which of those extras are NOT numbers. Everything else in EXTRA_FIELDS is coerced with Number()
// and refused if it is not finite — the original code special-cased the single field named "code",
// which stopped being enough the moment a list had a parent id, a description and a boolean.
const TEXT_FIELDS = new Set(["code", "parent", "description", "head_type", "pre_approved_basis"]);
const BOOL_FIELDS = new Set(["pre_approved"]);

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ list: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { list } = await ctx.params;
  const Model = LISTS[list];
  if (!Model) throw new HttpError(404, "Unknown list");
  // Lazy seed: the scheme master mirrors the SCHEME enum so Program.scheme values always
  // have a row to hang their hours on — created once, empty of facts until Admin fills them.
  // QA-131 rider: Admin-only now — a GET that writes must not be reachable by every role.
  if (list === "schemes" && user.role === "Admin" && (await Scheme.countDocuments({})) === 0) {
    await Scheme.insertMany(SCHEME.map((name) => ({ name, active: true }))).catch(() => {});
  }
  let items = await Model.find({}).sort({ name: 1 }).lean();
  // QA-131 (S1, checker 15/08): amount_received is the per-scheme money the client pays —
  // the one field the CEO called admin-only — and this route was handing it to every
  // signed-in role, trainers included. Hours stay readable; the money leaves the payload
  // for everyone but Admin (maskTrainerSecrets pattern: strip on a copy, not a projection,
  // so the Admin path stays a single query).
  if (list === "schemes" && user.role !== "Admin") {
    items = (items as any[]).map(({ amount_received: _a, ...safe }) => safe);
  }
  // QA-1828: the cost-category master carries `budget`, `pre_approved_amount` and a
  // `pre_approved_basis` whose entire content is a money rule. This list must stay readable by every
  // role — the Costs form needs the head and subhead names, and *"cost ki entry apne-apne level ki
  // koi bhi karta hai"* — so the structure travels and the money does not.
  //
  // NOT `user.role !== "Admin"` like the scheme line above it: the CEO's rule is that Admin is
  // precisely the role this must not open for (`NO_ADMIN_BYPASS`), so the test is the GRANT.
  if (list === "cost-categories") {
    items = maskCostCategoryMoneyList(items as any[], await hasPermission(user, FINANCE_VIEW));
  }
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ list: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin"); // Rule 40
  const { list } = await ctx.params;
  const Model = LISTS[list];
  if (!Model) throw new HttpError(404, "Unknown list");
  const body = await readJson(req);
  const name = String(body.name ?? "").trim();
  if (!name) throw new HttpError(400, "name required");
  // F-B17 (2026-08-14): "Trainer Fee" and "Trainer fee" both existed in production and
  // the trainer-fee auto-suggest matched neither reliably. Names are unique per list,
  // case-insensitively — the refusal names the existing entry so the fix is obvious.
  const dupe = await Model.findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } }).lean();
  if (dupe) throw new HttpError(409, `"${dupe.name}" already exists in this list — names are unique (case-insensitive).`);
  await assertMayWriteCategoryMoney(user, list, body);
  const extras = await coerceExtras(list, body);
  const item = await Model.create({ name, active: body.active ?? true, ...extras });
  return NextResponse.json({ item }, { status: 201 });
});

// Masking a field on READ while leaving it writable is half a rule, and the worse half: an Admin
// without the grant could set a budget they are not allowed to see, and never learn what they
// overwrote. So the money fields on this master need `finance.view` to be WRITTEN too — you cannot
// coherently set a figure you may not read back. The rest of the row (name, code, parent,
// description, head type, the pre-approved FLAG) stays writable by any Admin, because that is
// structure and the CEO's rule is about money.
export async function assertMayWriteCategoryMoney(user: SessionUser, list: string, body: Record<string, any>) {
  if (list !== "cost-categories") return;
  const touching = COST_CATEGORY_MONEY_FIELDS.filter((f) => body[f] !== undefined);
  if (!touching.length) return;
  await requireFinance(user, "view");
}

// One place that turns a request body into writable fields for BOTH doors. It used to be inline
// here and again in `[id]/route.ts` — two copies of the same coercion, which is the ARCHITECTURE §3
// fault, and the copies had already started to differ before this change added anything to them.
export async function coerceExtras(list: string, body: Record<string, any>): Promise<Record<string, unknown>> {
  const extras: Record<string, unknown> = {};
  for (const f of EXTRA_FIELDS[list] ?? []) {
    if (body[f] === undefined) continue;
    // An explicitly cleared field must be able to become empty again — a head that stops being
    // pre-approved, a budget that is withdrawn. `undefined` means "not sent"; "" and null mean
    // "cleared", and only the first is skipped.
    if (body[f] === null || body[f] === "") { extras[f] = f === "parent" ? null : undefined; continue; }
    if (BOOL_FIELDS.has(f)) { extras[f] = body[f] === true || body[f] === "true"; continue; }
    if (TEXT_FIELDS.has(f)) { extras[f] = String(body[f]).trim(); continue; }
    extras[f] = Number(body[f]);
    if (!Number.isFinite(extras[f] as number)) throw new HttpError(400, `${f} must be a number`);
    // QA-1875 (checker on qa-1828a): consolidating two coercions into one DROPPED a guard the copy
    // it replaced had — `[id]/route.ts`'s NUMERIC branch refuses `n < 0`, and this one did not, so a
    // budget of −50,000 was accepted. That is the specific risk of removing a second copy: the
    // copies are rarely identical, and the one being deleted may be the stricter of the two. Every
    // money figure on a master is non-negative, exactly as `total_hours`, `min_required_hours` and
    // `amount_received` already are in the same family.
    if ((extras[f] as number) < 0) throw new HttpError(400, `${f} must be a non-negative number`);
  }
  // QA-1828: TWO LEVELS, and the API is where that is true rather than the form. A subhead of a
  // subhead is a taxonomy nobody asked for and a report nobody can read; a category that is its own
  // parent is a cycle that hangs any walk of the tree.
  if (list === "cost-categories" && extras.parent) {
    const parent = await CostCategory.findById(String(extras.parent)).select("parent name").lean<any>();
    if (!parent) throw new HttpError(400, "That head does not exist.");
    if (parent.parent) {
      throw new HttpError(400, `"${parent.name}" is itself a subhead — cost heads are two levels deep (head → subhead), so a subhead cannot have children.`);
    }
  }
  return extras;
}
