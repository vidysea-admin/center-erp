import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { MailLog, User } from "@/models";
import { getDefaults } from "@/lib/defaults";

// QA-115 (CEO [19:48] "I didn't get the mail" — 2026-08-15): the product's first real
// outbound-email layer. Pattern ported from pathlynks-self-discovery-quiz (the working
// SES SMTP setup: ap-south-1, port 587, STARTTLS) — WITHOUT its flaws: no open send
// endpoint, no client-built HTML, no per-request transport.
//
// Design rules that must survive future edits:
//  - Credentials come from ENV ONLY (SES_SMTP_*), never from Defaults/DB — the defaults
//    GET is readable by every authenticated user (SEC-01 lesson: creds never where a
//    reader can lift them).
//  - sendMail NEVER throws and never blocks a business action: no creds / toggle off →
//    MailLog "skipped"; SES error → MailLog "failed". Callers fire-and-forget.
//  - Every attempt lands in MailLog — "mail gaya ki nahi?" is answerable from records.

const FROM_NAME = () => process.env.MAIL_FROM_NAME || "Vidysea Center ERP";
const FROM_EMAIL = () => process.env.MAIL_FROM_EMAIL || "product@vidysea.com";

export function mailConfigured(): boolean {
  // MAIL_DISABLED=1 is the CI/wall override: PowerShell deletes a variable assigned "",
  // so "blank the creds" cannot be expressed there — an explicit flag can. The e2e wall
  // runs with this set so no test run can ever send real mail (learned the hard way:
  // the first -54 wall mailed the team through the .env.local creds).
  if (process.env.MAIL_DISABLED === "1") return false;
  return !!(process.env.SES_SMTP_USER && process.env.SES_SMTP_PASS);
}

// Module-singleton pooled transport — pathlynks rebuilt one per request; we do not.
let transporter: Transporter | null = null;
export function getTransporter(): Transporter | null {
  if (!mailConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SES_SMTP_HOST || "email-smtp.ap-south-1.amazonaws.com",
      port: parseInt(process.env.SES_SMTP_PORT || "587", 10),
      secure: false, // 587 = STARTTLS, the proven pairing from pathlynks
      auth: { user: process.env.SES_SMTP_USER!, pass: process.env.SES_SMTP_PASS! },
      pool: true, maxConnections: 3,
    });
  }
  return transporter;
}

// Small server-built HTML wrapper — English copy, ERP blue, no client input ever lands
// here unescaped beyond names the server already stores.
export function renderMail(opts: { title: string; lines: string[]; cta?: { label: string; url: string } }): { html: string; text: string } {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
  <div style="background:#1d4ed8;color:#ffffff;padding:14px 20px;font-size:16px;font-weight:bold">Vidysea Center ERP</div>
  <div style="padding:20px;color:#111827;font-size:14px;line-height:1.6">
    <p style="font-size:15px;font-weight:bold;margin:0 0 10px">${esc(opts.title)}</p>
    ${opts.lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join("\n    ")}
    ${opts.cta ? `<p style="margin:16px 0 4px"><a href="${opts.cta.url}" style="background:#1d4ed8;color:#ffffff;text-decoration:none;padding:9px 18px;border-radius:6px;display:inline-block">${esc(opts.cta.label)}</a></p>` : ""}
  </div>
  <div style="padding:10px 20px;background:#f9fafb;color:#6b7280;font-size:11px">This is an automated message from the Vidysea Center ERP. Please do not reply to this email.</div>
</div>`;
  const text = [opts.title, "", ...opts.lines, ...(opts.cta ? ["", `${opts.cta.label}: ${opts.cta.url}`] : [])].join("\n");
  return { html, text };
}

export type MailAttempt = {
  to: string;
  subject: string;
  // QA-142 (checker, 16/08): what the LOG stores when the real subject carries a secret —
  // the OTP mail keeps its code in the subject (phone notification preview), but the Admin
  // mail panel must not become a live-codes list. Bodies were deliberately never stored;
  // the subject line had quietly undone that decision.
  log_subject?: string;
  html: string;
  text: string;
  entity?: string;
  entity_id?: unknown;
};

// The one door out. Resolves to the MailLog outcome; never rejects.
export async function sendMail(m: MailAttempt): Promise<{ status: "sent" | "failed" | "skipped"; reason?: string }> {
  const log = async (status: "sent" | "failed" | "skipped", extra: { reason?: string; message_id?: string } = {}) => {
    await MailLog.create({ to: m.to, subject: m.log_subject ?? m.subject, status, entity: m.entity, entity_id: m.entity_id, ...extra }).catch(() => {});
    return { status, reason: extra.reason };
  };
  try {
    if (!m.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.to)) return await log("skipped", { reason: "no valid recipient address" });
    const defaults = await getDefaults();
    if (defaults.email_enabled === false) return await log("skipped", { reason: "email_enabled is off in Defaults" });
    const t = getTransporter();
    if (!t) return await log("skipped", { reason: "not configured (SES_SMTP_USER/PASS env missing)" });
    const info = await t.sendMail({ from: `"${FROM_NAME()}" <${FROM_EMAIL()}>`, to: m.to, subject: m.subject, text: m.text, html: m.html });
    return await log("sent", { message_id: info.messageId });
  } catch (e) {
    return await log("failed", { reason: e instanceof Error ? e.message : String(e) });
  }
}

// Mirror an "instant" notification to the mailboxes of the users it targets — active,
// approved accounts only, Rule-38 location scope respected (an unscoped user of a
// targeted role always qualifies; a scoped one only if the location matches or none is
// given). Trainer-role accounts are people who work at centres — included when targeted.
export async function mailUsersByRole(opts: { roles: string[]; location?: unknown; subject: string; title: string; lines: string[]; link?: string; entity?: string; entity_id?: unknown }) {
  const users = await User.find({
    role: { $in: opts.roles }, active: true, dropped: { $ne: true },
    approval_status: { $ne: "Pending" },
  }).select("email role location_scope").lean<any[]>();
  const eligible = users.filter((u) => {
    if (!opts.location) return true;
    const scope = (u.location_scope ?? []).map(String);
    return scope.length === 0 || scope.includes(String(opts.location));
  });
  const seen = new Set<string>();
  const { html, text } = renderMail({
    title: opts.title, lines: opts.lines,
    cta: opts.link ? { label: "Open in the ERP", url: `https://www.vidysea.com/erp${opts.link}` } : undefined,
  });
  for (const u of eligible) {
    const to = String(u.email ?? "").toLowerCase();
    if (!to || seen.has(to)) continue;
    seen.add(to);
    await sendMail({ to, subject: opts.subject, html, text, entity: opts.entity, entity_id: opts.entity_id });
  }
  return seen.size;
}
