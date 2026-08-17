import { MailLog } from "@/models";
import { getDefaults } from "@/lib/defaults";
import { testEnvironmentShape } from "@/lib/mailer";

// -110 (Umesh 17/08, checker QA-187..190): the product's outbound-SMS door — EnableX, India, DLT.
// Built as the twin of lib/mailer.ts so there is ONE pattern for "send something to a person",
// not two. Umesh's scope: EnableX carries SMS and (later) WhatsApp; email stays on SES.
//
// Design rules that must survive future edits — each one is a lesson already paid for:
//  - Credentials come from ENV ONLY (ENABLEX_SMS_*), read from the app's own directory. The
//    checker found the first attempt in d:/erp/.env, the PARENT of the app, under lowercase names
//    the code never read: 30 process.env names in src/, not one of them SMS. (QA-187)
//  - sendSms NEVER throws and never blocks a business action. Every outcome — sent, skipped,
//    failed — resolves to a MailLog row with channel "sms". Callers fire-and-forget.
//  - The wall must never text a real student. Suppression is STRUCTURAL first (the same
//    testEnvironmentShape mailer uses: a non-production DB or a localhost auth URL means OFF, flag
//    or no flag) and SMS_DISABLED=1 second — MAIL_DISABLED's twin, because "the first -54 wall
//    run mailed the team" must not repeat with 167 students' phone numbers, where it costs money.
//  - The template is DATA, never a sentence in code. India's DLT gateway matches the approved text
//    literally; the only approved template on this account today is the OTP one, and the wording
//    in circulation on an older screenshot is a DIFFERENT template that would be rejected. So a
//    send renders the approved text by substitution, and a purpose with no configured template ID
//    cannot send at all — it records "skipped: no approved DLT template", it does not guess.
//
// Wire contract, read from developer.enablex.io/messaging/sms.html on 2026-08-17 (their doc host
// 403s automated fetches, so this was read in a browser and is pinned here verbatim):
//   POST https://api.enablex.io/sms/v1/messages/
//   Authorization: Basic base64(APP_ID:APP_KEY)          "Each SMS project is assigned an APP ID and APP Key"
//   { "from": <sender id>, "to": ["+91..."], "type": "sms",
//     "campaign_id": <required — "you must create at least one campaign before sending SMS via the API">,
//     "template_id": <approved template>, "data": { <placeholder>: <value> }, "data_coding": "plain" }
//   success: { "result": 0, "job_id": "<tracking id>" }
// Provisioned on the account (portal, 2026-08-17): project VIDYSEA_SMS_ENABLE_X, sender VIDYSE
// (fulfilled 30-06-26), campaign "NEW SMS CAMPAIGN" 29283543 ACTIVE, DLT template 888579131:
//   "Hi {$var1} , OTP for verification is {$var2}. Team vidysea ."     (var1 = name, var2 = code)

const ENDPOINT = process.env.ENABLEX_SMS_ENDPOINT || "https://api.enablex.io/sms/v1/messages/";

export type SmsPurpose = "otp" | "registration" | "attendance_link" | "feedback_link" | "sidh_link";

// A purpose is sendable ONLY when its DLT template ID is configured. Today that is OTP alone —
// Umesh's call: "abhi bas OTP wala, wo already approved hai; usse confidence milegi, phir baaki
// approve karwate rahenge." Adding a purpose later is one env line, no code.
export type SmsTemplate = { id: string; text: string; vars: string[] };
export function smsTemplateFor(purpose: SmsPurpose): SmsTemplate | null {
  const id = process.env[`ENABLEX_SMS_TEMPLATE_${purpose.toUpperCase()}`];
  if (!id) return null;
  // The approved TEXT for each purpose. Kept beside its env key so an operator reading this file
  // sees exactly what will land on the phone; substitution happens on {$varN} only.
  const TEXT: Record<SmsPurpose, { text: string; vars: string[] }> = {
    otp:             { text: "Hi {$var1} , OTP for verification is {$var2}. Team vidysea .", vars: ["name", "code"] },
    // The four below have NO approved template yet (verified on the portal 2026-08-17). Their env
    // key stays unset until Umesh gets each approved on DLT, so they cannot send by construction.
    registration:    { text: "Hello {$var1}! You have been registered for {$var2} at {$var3}. Our team will contact you shortly.", vars: ["name", "program", "centre"] },
    attendance_link: { text: "Hello {$var1}! View your attendance and exam eligibility here: {$var2}", vars: ["name", "url"] },
    feedback_link:   { text: "Hello {$var1}! Please share your training feedback: {$var2}", vars: ["name", "url"] },
    sidh_link:       { text: "Hello {$var1}! Please register for your training on the Skill India portal: {$var2}", vars: ["name", "url"] },
  };
  return { id, ...TEXT[purpose] };
}

export function renderSmsBody(t: SmsTemplate, values: Record<string, string>): string {
  return t.vars.reduce((body, key, i) => body.replaceAll(`{$var${i + 1}}`, String(values[key] ?? "")), t.text);
}

// Mirrors mailConfigured() exactly, in the same order, for the same reasons (QA-129: suppression is
// the DEFAULT, recognised structurally, not a flag someone must remember to set).
export function smsConfigured(): boolean {
  if (testEnvironmentShape()) return false;
  if (process.env.SMS_DISABLED === "1") return false;
  return !!(process.env.ENABLEX_SMS_APP_ID && process.env.ENABLEX_SMS_APP_KEY && process.env.ENABLEX_SMS_CAMPAIGN_ID);
}

// What the Admin panel is allowed to see: presence, never a value (SEC-01 lesson).
export function smsHealth() {
  const shape = testEnvironmentShape();
  const missing = ["ENABLEX_SMS_APP_ID", "ENABLEX_SMS_APP_KEY", "ENABLEX_SMS_CAMPAIGN_ID", "ENABLEX_SMS_SENDER_ID"].filter((k) => !process.env[k]);
  const templates = (["otp", "registration", "attendance_link", "feedback_link", "sidh_link"] as SmsPurpose[])
    .map((p) => ({ purpose: p, template_id: process.env[`ENABLEX_SMS_TEMPLATE_${p.toUpperCase()}`] ?? null }));
  return {
    configured: smsConfigured(),
    provider: "enablex",
    reason: shape ? `test environment (${shape}) — SMS suppressed by default`
      : process.env.SMS_DISABLED === "1" ? "SMS_DISABLED=1"
        : missing.length ? `not configured — missing ${missing.join(", ")}`
          : "EnableX SMS connected",
    sender_id: process.env.ENABLEX_SMS_SENDER_ID ?? null,
    templates,
  };
}

// India-only for now: the roster's phone field is a bare 10-digit mobile (validate.ts canonicalPhone).
export function e164India(phone: unknown): string | null {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 10) return "+91" + d;
  if (d.length === 12 && d.startsWith("91")) return "+" + d;
  if (d.length === 11 && d.startsWith("0")) return "+91" + d.slice(1);
  return null;
}

export type SmsAttempt = {
  to: unknown;                       // phone in any of the shapes e164India accepts
  purpose: SmsPurpose;
  values: Record<string, string>;    // template variables by NAME (see SmsTemplate.vars)
  log_preview?: string;              // what to write in the log INSTEAD of the body (never a live OTP)
  entity?: string;
  entity_id?: unknown;
  reference?: string;                // our tracking string, echoed by EnableX
};

// The one door out. Resolves to the MailLog outcome; never rejects.
export async function sendSms(m: SmsAttempt): Promise<{ status: "sent" | "failed" | "skipped"; reason?: string; job_id?: string }> {
  const template = smsTemplateFor(m.purpose);
  const to = e164India(m.to);
  const preview = m.log_preview ?? (template ? renderSmsBody(template, m.values).slice(0, 80) : m.purpose);
  const log = async (status: "sent" | "failed" | "skipped", extra: { reason?: string; message_id?: string } = {}) => {
    await MailLog.create({
      channel: "sms",
      to: to ?? (m.to && String(m.to).trim() ? String(m.to) : "(no phone on record)"),
      subject: preview, template_id: template?.id ?? null,
      status, entity: m.entity, entity_id: m.entity_id, ...extra,
    }).catch(() => {});
    return { status, reason: extra.reason, job_id: extra.message_id };
  };
  try {
    if (!to) return await log("skipped", { reason: "no valid mobile number" });
    if (!template) return await log("skipped", { reason: `no approved DLT template configured for "${m.purpose}" (ENABLEX_SMS_TEMPLATE_${m.purpose.toUpperCase()})` });
    const shape = testEnvironmentShape();
    if (shape) return await log("skipped", { reason: `test environment (${shape}) — SMS suppressed by default` });
    if (process.env.SMS_DISABLED === "1") return await log("skipped", { reason: "SMS_DISABLED=1" });
    const defaults = await getDefaults();
    if ((defaults as any).sms_enabled === false) return await log("skipped", { reason: "sms_enabled is off in Defaults" });
    const appId = process.env.ENABLEX_SMS_APP_ID, appKey = process.env.ENABLEX_SMS_APP_KEY, campaign = process.env.ENABLEX_SMS_CAMPAIGN_ID;
    if (!appId || !appKey || !campaign) return await log("skipped", { reason: "not configured (ENABLEX_SMS_APP_ID / APP_KEY / CAMPAIGN_ID env missing)" });

    // Variables travel as `data` and EnableX substitutes into the APPROVED body server-side — we do
    // not send free text, so a body that drifted from the DLT-approved wording cannot leave here.
    const data: Record<string, string> = {};
    template.vars.forEach((key, i) => { data[`var${i + 1}`] = String(m.values[key] ?? ""); });
    const payload: Record<string, unknown> = {
      to: [to], type: "sms", campaign_id: campaign, template_id: template.id, data, data_coding: "plain",
      ...(process.env.ENABLEX_SMS_SENDER_ID ? { from: process.env.ENABLEX_SMS_SENDER_ID } : {}),
      ...(m.reference ? { reference: m.reference } : {}),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${appId}:${appKey}`).toString("base64") },
        body: JSON.stringify(payload), signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    const body: any = await res.json().catch(() => ({}));
    // EnableX: { result: 0, job_id } on success; non-zero result / desc on refusal.
    if (res.ok && (body?.result === 0 || body?.job_id)) return await log("sent", { message_id: String(body.job_id ?? "") });
    return await log("failed", { reason: `EnableX ${res.status}: ${String(body?.desc ?? body?.error ?? body?.message ?? JSON.stringify(body)).slice(0, 200)}` });
  } catch (e) {
    return await log("failed", { reason: e instanceof Error ? e.message : String(e) });
  }
}
