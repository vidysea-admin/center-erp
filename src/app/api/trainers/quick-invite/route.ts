import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, isScoped } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { PublicToken, Trainer } from "@/models";
import { audit } from "@/lib/audit";
import { emailError, canonicalPhone } from "@/lib/validate";
import { renderMail, sendMail } from "@/lib/mailer";
import { assertTrainerInScope } from "@/lib/rules";

// Quick-invite (CEO 13/08): "chhota sa form — naam, email, phone dala, link bana, WhatsApp/
// SMS chala gaya; trainer khud baaki bhar de, mere staff ka kaam kam ho." Creates the
// Trainer at "Fresh Lead" and mints a single-use trainer_apply link that completes the profile.
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "trainers.manage"); // Admin/Ops — and the principal, per the role matrix
  const body = await req.json();
  const S = (v: unknown) => String(v ?? "").trim();
  const name = S(body.name), email = S(body.email);
  // QA-141: the old slice(-10) silently accepted a 15-digit keyboard-mash as its last ten.
  // canonicalPhone refuses anything that is not a real 10-digit form (+91/0 prefixes fine).
  const phone = canonicalPhone(body.phone);
  if (!name || !phone) throw new HttpError(400, "Name and a 10-digit phone are required (a +91/0 prefix is fine).");
  if (email) {
    const eErr = emailError(email, { optional: true });
    if (eErr) throw new HttpError(400, eErr);
  }

  // One live profile per phone — re-inviting someone re-uses their record and a fresh link.
  let tr = await Trainer.findOne({ phone });
  if (!tr) {
    tr = await Trainer.create({
      name, phone, email: email || undefined,
      skills: ["(to be filled by the applicant)"], // model requires skills; the form replaces this
      pipeline_status: "Fresh Lead", status: "Available", source: "Quick invite",
      created_by: user.id, // QA-130 rider: "kisne banaya" rides on the row

      // QA-125: a scoped inviter's trainer is tied to their own centre(s) — otherwise the
      // invitee would be invisible to the very person who invited them (and untied rows
      // are now 403 for every scoped user, by design).
      ...(isScoped(user) ? { capable_locations: user.location_scope } : {}),
    });
  } else if (isScoped(user)) {
    // Re-inviting an existing person: the scoped inviter must already be allowed to
    // touch this trainer — same Rule 38 as every other by-id write.
    await assertTrainerInScope(user, String(tr._id));
  }
  // Burn any earlier unused link for this trainer — exactly one live link at a time.
  await PublicToken.updateMany({ purpose: "trainer_apply", trainer: tr._id, active: true }, { $set: { active: false } });
  const token = crypto.randomBytes(16).toString("hex");
  await PublicToken.create({ token, purpose: "trainer_apply", trainer: tr._id, created_by: user.id });
  await audit({ entity: "Trainer", entityId: tr._id, field: "quick_invite", newValue: `apply link minted by ${user.email ?? user.id}`, actor: user.id });
  // QA-115: the address was collected here and then never used — now the link goes to the
  // applicant's inbox too (WhatsApp/copy stays the staff flow). Fire-and-forget.
  const mailed = !!(email || tr.email);
  if (mailed) {
    const { html, text } = renderMail({
      title: "Complete your trainer application",
      lines: [`Hello ${name || tr.name},`, `Vidysea has invited you to apply as a trainer. The form takes a few minutes — your name and phone are already filled in.`],
      cta: { label: "Open the application form", url: `https://www.vidysea.com/erp/p/trainer-apply?token=${token}` },
    });
    sendMail({ to: (email || tr.email)!, subject: "Complete your trainer application — Vidysea", html, text, entity: "Trainer", entity_id: tr._id }).catch(() => {});
  }
  return NextResponse.json({ item: { trainer: tr._id, link: `/p/trainer-apply?token=${token}`, mailed } }, { status: 201 });
});
