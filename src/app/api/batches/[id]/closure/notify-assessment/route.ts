import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BASE_PATH } from "@/lib/base-path";
import { Batch, Closure } from "@/models";
import { assertBatchInScope, mintMemberLinks } from "@/lib/rules";
import { renderMail, sendMail } from "@/lib/mailer";
import { audit } from "@/lib/audit";

// QA-179 (2026-09-02, Manish 17/08 + Umesh 17/08: "trainer batayega ki kab aapki assessment
// date hai... trainer ke end mein send mail wali functionality ho taaki har user ko mail chala
// jaaye"): the candidate's OWN view (/p/attendance/[token]) has shown the assessment date for
// weeks — what never existed is a way for the trainer to actually TELL them. This is that send
// path, and nothing else from QA-179's much longer wishlist (mock-test status enum, fail-reason
// capture, certificate numbers) — those are still owed a design decision from Manish.
//
// Two safety requirements, because this is the first outbound mail to real students (161 real
// addresses today, thousands at rollout):
//  1. REFUSE when Closure.assessment_date is empty — otherwise the first press mails every
//     enrolled candidate a blank date and cannot be recalled.
//  2. The caller must see the batch and the recipient COUNT before committing — a send-to-
//     everyone is not reversible, so the confirm lives on the client, and this route reports
//     back exactly who was mailed and who was not, never silently.
export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage"); // same right the assessment date itself is saved under
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38

  const [batch, closure] = await Promise.all([
    Batch.findById(id).select("code program").populate("program", "name").lean<any>(),
    Closure.findOne({ batch: id }).select("assessment_date").lean<any>(),
  ]);
  if (!batch) throw new HttpError(404, "Batch not found");
  if (!closure?.assessment_date) {
    throw new HttpError(409, "Set an assessment date first — nothing to notify candidates about yet.");
  }
  const dateStr = new Date(closure.assessment_date).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });

  // Reuse (never re-mint) the same per-member attendance capability links the roster's own
  // "share attendance links" action already mints — one link per candidate, the same door.
  const links = await mintMemberLinks("attendance", id, user.id, "name phone email");

  let sent = 0;
  const skipped: { name: string; reason: string }[] = [];
  for (const l of links) {
    const candidate = l.batch_member?.candidate;
    const name = candidate?.name ?? "candidate";
    const to = String(candidate?.email ?? "").toLowerCase().trim();
    const { html, text } = renderMail({
      title: `Your assessment date — ${batch.program?.name ?? "your programme"}`,
      lines: [
        `Hi ${name},`,
        `Your assessment for ${batch.program?.name ?? "your programme"} (batch ${batch.code}) is scheduled on ${dateStr}.`,
        `You can check your attendance, hours and eligibility any time using the link below.`,
      ],
      cta: { label: "View my details", url: `https://www.vidysea.com${BASE_PATH}/p/attendance/${l.token}` },
    });
    const result = await sendMail({ to, subject: `Your assessment date is ${dateStr}`, html, text, entity: "BatchMember", entity_id: l.batch_member._id });
    if (result.status === "sent") sent++;
    else skipped.push({ name, reason: result.reason ?? result.status });
  }

  await audit({
    entity: "Batch", entityId: id, field: "assessment_notify",
    newValue: `notified ${sent}/${links.length} candidate(s) of the ${dateStr} assessment date${skipped.length ? ` — ${skipped.length} skipped` : ""}`,
    actor: user.id,
  });

  return NextResponse.json({ total: links.length, sent, skipped });
});
