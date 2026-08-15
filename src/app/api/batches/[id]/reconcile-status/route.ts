import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { activateFromEvidence, assertBatchInScope } from "@/lib/rules";

// -88 (Umesh 15/08): "jis batch me attendance upload ho gayi hai usme Start batch jaise
// buttons aa rahe hain — ye to apne aap hona chahiye." The import path activates on commit;
// this verb covers batches that already carried evidence before -88 (DST-02) and any other
// way evidence arrives: the batch page calls it once when it sees attendance on a
// Planning/Ready batch, and the status catches up with reality. Idempotent; no gate beyond
// scope — activation from evidence is the SYSTEM's conclusion, recorded as such.
export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);
  const res = await activateFromEvidence(id, { actor: user.id, source: "reconcile on open" });
  return NextResponse.json(res);
});
