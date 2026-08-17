import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { MailLog } from "@/models";
import { getTransporter, mailConfigured, renderMail, sendMail } from "@/lib/mailer";
import { storageHealth } from "@/lib/storage";
import { smsHealth } from "@/lib/sms";

// QA-115: the one-click "is mail actually working?" check, Admin-only.
// GET  → config state + the last 20 MailLog rows (the audit answer to "mail gaya ki nahi").
// POST → verifies the SMTP connection; with {send_to_self:true} also sends a real test
//        mail to the signed-in admin's own address. Nothing here is an open relay — the
//        recipient is always the admin themselves.

export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin");
  const log = await MailLog.find({}).sort({ createdAt: -1 }).limit(20).lean();
  // QA-145: evidence-storage health rides along — same admin panel, one call.
  // -110: SMS health rides along too — presence of each ENABLEX_SMS_* key and which purposes
  // have an approved template, never a value (SEC-01).
  return NextResponse.json({ configured: mailConfigured(), log, storage: storageHealth(), sms: smsHealth() });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin");
  if (!mailConfigured()) {
    throw new HttpError(400, "Mail is not configured on the server — the SES_SMTP_* environment variables are missing. Sending stays safely off until they are set.");
  }
  const body = await req.json().catch(() => ({}));
  try {
    await getTransporter()!.verify();
  } catch (e) {
    throw new HttpError(502, `SMTP connection failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (body.send_to_self) {
    const { html, text } = renderMail({
      title: "Center ERP test email",
      lines: [`Hello ${user.name},`, "If you are reading this, outbound email from the Center ERP works.", `Sent at ${new Date().toISOString()}.`],
    });
    const result = await sendMail({ to: user.email, subject: "Center ERP test email", html, text, entity: "User" });
    return NextResponse.json({ verified: true, ...result });
  }
  return NextResponse.json({ verified: true });
});
