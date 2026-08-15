import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { MailLog } from "@/models";
import { audit } from "@/lib/audit";

// QA-132 (-72, maker-half): the product finally LISTENS for what happens after SES accepts a
// mail. AWS SNS posts here on Bounce/Complaint (and SubscriptionConfirmation when devops
// wires the topic — their one console step: SES → SNS topic → HTTPS subscription to this
// URL). A bounced row stops reading "sent" forever; the Admin mail panel shows the truth.
//
// Hardening: SNS requests carry x-amz-sns-message-type; when SES_SNS_TOPIC_ARN is set in the
// env, the TopicArn must match (a stray/forged post cannot touch rows). Full signature
// verification (cert fetch + RSA) is a later hardening step, recorded in the register — the
// blast radius here is limited to flipping mail-log statuses on matching SES message-ids.
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  if (!req.headers.get("x-amz-sns-message-type")) throw new HttpError(400, "Not an SNS message.");
  const body = await req.json().catch(() => null);
  if (!body?.Type) throw new HttpError(400, "Not an SNS message.");
  const expectArn = process.env.SES_SNS_TOPIC_ARN;
  if (expectArn && body.TopicArn !== expectArn) throw new HttpError(403, "Unknown topic.");

  if (body.Type === "SubscriptionConfirmation" && body.SubscribeURL) {
    // Confirm only AWS-hosted URLs — never fetch an arbitrary address (SSRF guard).
    const u = new URL(body.SubscribeURL);
    if (!u.hostname.endsWith(".amazonaws.com")) throw new HttpError(400, "Refusing non-AWS subscribe URL.");
    await fetch(body.SubscribeURL).catch(() => {});
    await audit({ entity: "MailLog", entityId: "000000000000000000000000", field: "sns_subscription", newValue: `confirmed (${body.TopicArn ?? "no arn"})`, actorType: "EXTERNAL_SYNC" });
    return NextResponse.json({ ok: true });
  }

  if (body.Type === "Notification") {
    const msg = typeof body.Message === "string" ? JSON.parse(body.Message ?? "{}") : (body.Message ?? {});
    const kind = msg.notificationType; // "Bounce" | "Complaint" | "Delivery"
    const messageId = msg.mail?.messageId;
    if (!messageId || !["Bounce", "Complaint"].includes(kind)) return NextResponse.json({ ok: true, ignored: true });
    const reason = kind === "Bounce"
      ? `bounced (${msg.bounce?.bounceType ?? "?"}): ${(msg.bounce?.bouncedRecipients ?? []).map((r: any) => r.diagnosticCode ?? r.emailAddress).join("; ").slice(0, 300)}`
      : `complaint (${msg.complaint?.complaintFeedbackType ?? "?"})`;
    // SES messageId may arrive with/without the <> wrapper nodemailer stored — match both.
    const upd = await MailLog.updateMany(
      { message_id: { $in: [messageId, `<${messageId}>`] } },
      { $set: { status: kind === "Bounce" ? "bounced" : "complained", reason } },
    );
    if (upd.modifiedCount) {
      await audit({ entity: "MailLog", entityId: "000000000000000000000000", field: "ses_notification", newValue: `${kind} → ${upd.modifiedCount} row(s): ${reason.slice(0, 120)}`, actorType: "EXTERNAL_SYNC" });
    }
    return NextResponse.json({ ok: true, updated: upd.modifiedCount ?? 0 });
  }

  return NextResponse.json({ ok: true, ignored: true });
});
