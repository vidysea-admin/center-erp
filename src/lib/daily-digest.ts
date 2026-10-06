import mongoose from "mongoose";
import { User } from "@/models";
import { getDefaults } from "@/lib/defaults";
import { dbConnect, takeJobLock } from "@/lib/db";
import { renderMail, sendMail, suppressFor } from "@/lib/mailer";
import { dailyDigest, istDayOf, istMinuteOfDay, type DailyDigest } from "@/lib/rules";
import type { SessionUser } from "@/auth";

// mtg-c1 (R4, Umesh 2026-10-06: "Screen + 1 mail"). The daily digest MAIL: who gets it, how it is
// rendered per person, and the once-a-day send. Every NUMBER comes from `dailyDigest` (rules.ts) - this
// file only decides recipients, wording and timing, so the screen, the Publish-now button and this mail
// can never disagree.
//
// ONE MAIL PER DAY, however many containers and however many restarts. Two independent guards:
//   1. `takeJobLock("daily-digest")` - the same lock the other three scheduler ticks use, so two
//      containers ticking at 21:00 do not both start sending;
//   2. a DURABLE per-recipient day claim, an insert into `job_locks` with _id `digest-sent:<day>:<email>`.
//      The unique _id makes the claim atomic; a duplicate-key error means "already sent". It outlives the
//      lock's TTL and a restart, which is what stops a container that boots at 21:30 on a day already
//      sent from sending again. The claim is made BEFORE the send, so a crash mid-send errs on the side
//      of one mail missed, never two sent; a failed send is recorded (MailLog) and is not retried by the
//      tick - "Publish now" on the screen is the manual recovery.
export const DIGEST_HOUR_IST = 21;

export type DigestResult = {
  to: string;
  // mailed = handed to the one mail door (sendMail); its own outcome is `status`. ineligible = not an
  // ERP account that may get the digest; silenced = the account's own mail switch is off.
  outcome: "mailed" | "ineligible" | "silenced" | "failed";
  status?: "sent" | "failed" | "skipped";
  reason?: string;
  text?: string;
};
export type DigestTickResult = { fired: boolean; day: string; reason?: string; results: DigestResult[] };

export function parseRecipients(raw: unknown): string[] {
  const seen = new Set<string>();
  for (const part of String(raw ?? "").split(/[,;\s]+/)) {
    const e = part.trim().toLowerCase();
    if (e) seen.add(e);
  }
  return [...seen];
}

type Resolved = { to: string; viewer: SessionUser | null; problem?: string; silenced?: string };

// Recipients are ERP ACCOUNTS: the per-recipient finance section is decided by that account's own
// permission, so an address that is not an account has no permission to read and gets nothing. Each
// problem is returned (and written to the MailLog by the caller) rather than dropped, so "why did X not
// get it?" is answerable from the record.
export async function resolveRecipients(): Promise<Resolved[]> {
  const addrs = parseRecipients((await getDefaults()).digest_recipients);
  if (!addrs.length) return [];
  const users = await User.find({ email: { $in: addrs } }).select("name email role location_scope can_edit active dropped approval_status mail_enabled").lean<any[]>();
  const byEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));
  return addrs.map((to): Resolved => {
    const u = byEmail.get(to);
    if (!u || u.active === false || u.dropped === true || u.approval_status === "Pending") {
      return { to, viewer: null, problem: "not an active ERP user account: the daily digest goes to ERP accounts only" };
    }
    if (u.role === "Trainer") return { to, viewer: null, problem: "Trainer accounts are not sent the daily digest" };
    return {
      to,
      viewer: { id: String(u._id), name: u.name, email: to, role: u.role, location_scope: (u.location_scope ?? []).map(String), can_edit: !!u.can_edit },
      silenced: suppressFor(u),
    };
  });
}

const digestSubject = (day: string) => `Daily digest ${day}`;
const rs = (n: number) => `Rs ${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// The mail body for ONE recipient. The Costs block is written only when the digest itself carries one
// (`costs` is null unless the viewer holds finance.view), so a recipient without the right gets a mail
// with no cost word and no cost figure in it at all.
export function digestMailContent(d: DailyDigest) {
  const c = d.candidates, t = d.trainers;
  const lines: string[] = [
    `Position for ${d.day} (IST).`,
    "Candidates",
    `Joined into batches: ${c.joined.total}`,
    ...c.joined.by_batch.map((b) => `  ${b.code}${b.location ? ` (${b.location})` : ""}: ${b.count}`),
    `Enrolled: ${c.enrolled.total}`,
    `Batches created: ${c.batches_created.length} | started: ${c.batches_started.length}`,
    ...(c.batches_created.length ? [`  Created: ${c.batches_created.map((b) => b.code).join(", ")}`] : []),
    ...(c.batches_started.length ? [`  Started: ${c.batches_started.map((b) => b.code).join(", ")}`] : []),
    `Mobilised (planning batches): ${c.mobilised.mobilised} of ${c.mobilised.target}, gap ${c.mobilised.gap}, across ${plural(c.mobilised.batches, "batch", "batches")}`,
    "Trainers",
    `${t.assigned} assigned to a live batch, ${t.idle} free to assign, ${t.unavailable} unavailable`,
    `Pipeline: ${t.pipeline.total} (${t.pipeline.buckets.map((b) => `${b.label} ${b.count}`).join(", ")})`,
    `Added on the day: ${t.added}`,
    ...(d.costs
      ? [
          "Costs",
          `Approved today: ${rs(d.costs.today.amount)} in ${plural(d.costs.today.entries, "entry", "entries")}`,
          `Month to date: ${rs(d.costs.month.amount)} in ${plural(d.costs.month.entries, "entry", "entries")}`,
          `Pending approval: ${rs(d.costs.pending.amount)} in ${plural(d.costs.pending.count, "request")}, of which ${rs(d.costs.pending.raised_today.amount)} was raised on the day`,
          `Payment pending: ${rs(d.costs.payment_pending.amount)} in ${plural(d.costs.payment_pending.count, "entry", "entries")}`,
        ]
      : []),
    "Mobilised and trainer figures are the position now. For an earlier day, pending and payment-pending count what had been raised by then and is still pending now.",
  ];
  return renderMail({
    title: `Daily digest, ${d.day}`,
    lines,
    cta: { label: "Open the daily digest", url: `https://www.vidysea.com/erp/reports/daily?date=${d.day}` },
  });
}

async function sendOne(day: string, r: Resolved, includeText: boolean): Promise<DigestResult> {
  const base = { to: r.to, subject: digestSubject(day), entity: "DailyDigest", html: "", text: "" };
  if (r.problem || !r.viewer) {
    const o = await sendMail({ ...base, suppress: r.problem ?? "not an active ERP user account" });
    return { to: r.to, outcome: "ineligible", status: o.status, reason: o.reason };
  }
  let content: { html: string; text: string };
  try {
    content = digestMailContent(await dailyDigest(day, r.viewer));
  } catch (e) {
    const o = await sendMail({ ...base, suppress: `the digest could not be built: ${e instanceof Error ? e.message : String(e)}` });
    return { to: r.to, outcome: "failed", status: o.status, reason: o.reason };
  }
  const o = await sendMail({ ...base, ...content, suppress: r.silenced });
  return { to: r.to, outcome: r.silenced ? "silenced" : "mailed", status: o.status, reason: o.reason, ...(includeText ? { text: content.text } : {}) };
}

// The durable "this recipient has had this IST day's digest" claim. true = the caller won it and must send.
async function claimDay(day: string, to: string, instance: string): Promise<boolean> {
  try {
    await mongoose.connection.db!.collection("job_locks").insertOne({ _id: `digest-sent:${day}:${to}` as any, day, to, instance, at: new Date() });
    return true;
  } catch (e: any) {
    if (e?.code === 11000) return false;   // somebody (this container earlier, or another) already claimed it
    throw e;
  }
}

// One scheduler tick. `now` and `instance` are arguments so a test drives the clock without touching the
// process clock; instrumentation passes neither `now` nor a fake instance.
export async function digestTick(opts: { now?: Date; instance?: string; includeText?: boolean } = {}): Promise<DigestTickResult> {
  const now = opts.now ?? new Date();
  const instance = opts.instance ?? "digest-" + process.pid;
  const day = istDayOf(now);
  if (istMinuteOfDay(now) < DIGEST_HOUR_IST * 60) return { fired: false, day, reason: `before ${DIGEST_HOUR_IST}:00 IST`, results: [] };
  await dbConnect();
  if (!(await takeJobLock("daily-digest", 10 * 60_000, instance))) {
    return { fired: false, day, reason: "another container holds the daily-digest lock", results: [] };
  }
  try {
    const recipients = await resolveRecipients();
    if (!recipients.length) return { fired: false, day, reason: "no recipients configured", results: [] };
    const results: DigestResult[] = [];
    for (const r of recipients) {
      if (!(await claimDay(day, r.to, instance))) continue;
      results.push(await sendOne(day, r, opts.includeText === true));
    }
    if (!results.length) return { fired: false, day, reason: `already sent for ${day}`, results };
    return { fired: true, day, results };
  } finally {
    // Released as soon as the work is done: the durable claims above, not this lock's TTL, are what stop a second send.
    await mongoose.connection.db!.collection("job_locks").deleteOne({ _id: "daily-digest" as any, holder: instance }).catch(() => {});
  }
}

// "Publish now": mail the digest to the recipient list at once, for any day, from the screen. Does not
// touch the day claims, so the 21:00 mail still goes (the two are different acts: this one is somebody
// pressing a button). A 30-second cooldown stops a double click mailing everyone twice. The caller has
// already checked defaults.manage.
export async function publishDigestNow(day: string, user: SessionUser) {
  const recipients = await resolveRecipients();
  if (!recipients.length) return { status: 409 as const, error: "No digest recipients are set. Add email addresses under Admin, Defaults, then press Publish now again." };
  if (!(await takeJobLock("daily-digest-manual", 30_000, user.id))) {
    return { status: 429 as const, error: "The digest was published a moment ago. Wait half a minute before publishing again." };
  }
  const results: DigestResult[] = [];
  for (const r of recipients) results.push(await sendOne(day, r, false));
  return {
    status: 200 as const,
    day,
    attempted: results.length,
    mailed: results.filter((r) => r.outcome === "mailed").length,
    ineligible: results.filter((r) => r.outcome === "ineligible").length,
    results,
  };
}
