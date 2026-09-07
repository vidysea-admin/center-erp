import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, locationFilter, readJson, HttpError } from "@/lib/authz";
import { requirePerm, requireFinance } from "@/lib/permissions";
import { CostEntry } from "@/models";
import { assertCostEntryValid, evaluatePreApproval } from "@/lib/rules";
import { requireApproval } from "@/lib/approvals";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // R-E (CEO 14/08 [25:06]): whoever POSTS money entries "shouldn't be able to see what has been
  // posted" — the ledger is a narrower right than the form. Their own submissions stay visible via
  // /api/approvals?mine=1, never the book.
  //
  // QA-1825 (CEO, 2026-09-05): that shape is unchanged; what changed is that it is no longer a
  // hardcoded role name. The old line read `if (user.role === "Operations") throw 403`, written
  // because "an ordered none<view<edit lattice cannot express edit-without-view". Splitting the
  // right instead of stretching the lattice expresses it exactly — costs.manage is the form,
  // finance.view is the book — and the CEO has since widened the rule far past Operations:
  // "kisi ke bhi paas nahi hogi chaahe super admin ho." An Admin without the grant now 403s here
  // too, which the role hardcode could never have done.
  await requireFinance(user, "view");
  const sp = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = { ...locationFilter(user) };
  for (const k of ["location", "batch", "trainer", "category"]) {
    const v = sp.get(k);
    if (v) filter[k] = v;
  }
  const items = await CostEntry.find(filter)
    .sort({ entry_date: -1 })
    .populate("location", "name code").populate("batch", "code").populate("trainer", "name").populate("category", "name").populate("entered_by", "name")
    .lean();
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "costs.manage");
  requireEdit(user); // Rule 39: can_edit=false is view-only everywhere, including granted rights
  const body = await readJson(req);
  assertCostEntryValid(body); // Rule 37
  // R-E: when the cost.post approval rule is enabled, a non-approver's entry PARKS instead
  // of writing the ledger — the CostEntry is created only by the approval replay. Admin (as
  // the configured approver) passes straight through, exactly as before.
  // QA-1828b: the description is the CEO's, not an optional note. *"हेड हो, सब हेड हो,
  // डिस्क्रिप्शन हो"* — and the example is a sentence explaining a decision, which is exactly the
  // thing that is unrecoverable later if nobody wrote it down at the time.
  if (!String(body.note ?? "").trim()) {
    throw new HttpError(400, "Say what this cost was for — the description is what makes it answerable later.");
  }

  // Is it pre-approved, and can a machine tell? A cap can be checked; a free-text basis cannot, so
  // that entry parks WITH the basis quoted rather than being waved through on a flag. The CEO named
  // the failing case himself: *"अब अगर उसके 29 रह गए… तो वो एक बार अप्रूव होनी चाहिए।"*
  // QA-1828c (CEO): *"अगर कोई नया है हेड या सब हेड, तो इनके पास इवैल्यूएशन होगी… तो हमारा सिस्टम
  // पूरा बंद हो जाएगा अगर हम ये यूज़ नहीं करेंगे।"* The failure he named is not a wrong figure - it is
  // people abandoning the system because the head they need is not in the list. So a missing head is
  // a QUEUE, not a refusal, and the WHOLE entry parks: nothing reaches the ledger until somebody has
  // decided where it belongs (Umesh, D8). `category` is therefore optional when `new_subhead` is
  // given, and Rule 37 is checked on the replay against whichever head is finally chosen.
  const proposed = String(body.new_subhead ?? "").trim();
  if (proposed) {
    const queued = await requireApproval("costcategory.create", user, {
      entity: "CostCategory",
      summary: `New cost head "${proposed}" for a ₹${body.amount} entry by ${user.name} — ${body.note}`,
      payload: { ...body, new_subhead: proposed },
      location: body.location || undefined,
    });
    // If nobody has enabled the rule there is no approver, and silently writing an unreviewed head
    // would be the opposite of what was asked. Say so instead of inventing one.
    if (!queued) throw new HttpError(409, "There is no approver set up for new cost heads yet, so this cannot be reviewed. Pick an existing head for now, or ask an Admin to turn that approval on.");
    return NextResponse.json({ queued: true, item: queued.request, awaiting: "a new cost head" }, { status: 202 });
  }

  const pre = await evaluatePreApproval(body.category, Number(body.amount));

  const parked = pre.applied ? null : await requireApproval("cost.post", user, {
    entity: "CostEntry",
    summary: `Cost entry ₹${body.amount} (${user.name})${body.note ? ` — ${body.note}` : ""}${pre.basis ? ` · pre-approved basis: ${pre.basis}` : ""}`,
    payload: { ...body, _pre_approved_basis: pre.basis },
    location: body.location || undefined,
  });
  if (parked) return NextResponse.json({ queued: true, item: parked.request, pre_approval: pre.reason }, { status: 202 });
  const doc = await CostEntry.create({
    entry_date: body.entry_date ?? new Date(),
    location: body.location || undefined, batch: body.batch || undefined, trainer: body.trainer || undefined,
    category: body.category, amount: body.amount, note: body.note,
    vendor_payee: body.vendor_payee || undefined,
    voucher_no: body.voucher_no || undefined,
    payment_mode: body.payment_mode || undefined,
    // The decision as it was AT POST TIME, with the sentence it was made against. A later edit to the
    // head must never rewrite what was approved today.
    pre_approved_applied: pre.applied,
    pre_approved_basis: pre.applied ? pre.basis ?? undefined : undefined,
    entered_by: user.id,
  });
  await audit({ entity: "CostEntry", entityId: doc._id, newValue: "created", actor: user.id });
  return NextResponse.json({ item: doc }, { status: 201 });
});
