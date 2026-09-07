import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, readJson } from "@/lib/authz";
import { requirePerm, hasPermission, maskInvoiceMoney, FINANCE_VIEW } from "@/lib/permissions";
import { CandidateResult, Closure, Invoice } from "@/models";
import { assertBatchInScope, enrolledWithoutCan, proposeInvoiceAmount, summarizeBatchResults, upsertClosureChecked } from "@/lib/rules";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const [closure, invoice, rows] = await Promise.all([
    Closure.findOne({ batch: id }).lean(),
    Invoice.findOne({ batch: id }).lean(),
    CandidateResult.find({ batch: id }).lean<any[]>(),
  ]);
  // QA-1834 (checker cycle 1, confirmed with live data): this returned the whole Invoice document —
  // amount, invoice_no, raised_on, paid_on — behind Rule 38 scope alone, while the SAME release
  // gated the client that renders those fields. The UI hid what the route still shipped, which made
  // it harder to notice rather than safer. A `requireFinance` here would be wrong: Operations needs
  // this screen, and refusing the whole payload would break the closure flow Umesh's ruling protects.
  // So the FIELD rule applies — money out, `status` stays (*"sirf paisa chhupao, status sabko rehne do"*).
  const canSeeMoney = await hasPermission(user, FINANCE_VIEW);
  // legacy === no per-candidate rows → the batch keeps its stored batch-level figures (Rule 41)
  return NextResponse.json({
    closure, invoice: maskInvoiceMoney(invoice, canSeeMoney),
    // QA-1831: the proposed amount is MONEY, so it rides the same field rule as the rest of the
    // invoice - a reader without finance.view gets null, not a figure. Computed here rather than in
    // the client because the rate lives on the scheme master and a client that fetched it would be
    // a second place the formula exists.
    invoice_proposal: canSeeMoney ? await proposeInvoiceAmount(id) : null,
    legacy: rows.length === 0,
    results_summary: await summarizeBatchResults(id, rows),
    // -156 (QA-445): a derivation that quietly does not happen is Manish's "mark complete karne se
    // kuch nahi ho raha" complaint one step earlier. The hand door says why when it is clicked;
    // this says why before anybody clicks. Legacy batches are exempt for the same reason the gate
    // itself is: a pre-portal paper batch was never asked for portal IDs.
    // -158 (QA-471): the NAME alone came back here and the screen rendered it twice for the two
    // students it cannot tell apart - in the unit that argued no screen may do that. It carries
    // what distinguishes them now; the helper had it all along and this line dropped it.
    certification_blocked_no_can: rows.length === 0
      ? []
      : (await enrolledWithoutCan(id)).map((x) => ({ name: x.name, phone: x.phone })),
  });
});

// PUT closure fields (Rules 34–35)
export const PUT = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const body = await readJson(req);
  const patch: Record<string, unknown> = {};
  for (const f of ["assessment_status", "assessment_date", "appeared", "passed", "result_file", "certification_status", "certification_date", "certificates_issued", "certificate_file", "ready_for_invoice",
    // -120 (M4-14): the chain's dates. Optional and independent — none of them gates anything.
    "mock_test_date", "result_expected_date", "certificate_distribution_date", "sidh_uploaded_on",
    // Rule 52 (CEO): the no-dues attestation that gates Completed → Closed.
    "dues_settled", "dues_note"]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  if (body.dues_settled !== undefined) {
    patch.dues_marked_by = user.id;
    patch.dues_marked_at = new Date();
  }
  const closure = await upsertClosureChecked(id, patch, user.id);
  await audit({ entity: "Closure", entityId: closure._id, field: "closure", newValue: patch, actor: user.id });
  return NextResponse.json({ item: closure });
});
