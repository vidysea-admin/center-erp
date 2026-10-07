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
// ONE MAIL PER DAY PER RECIPIENT THAT GOT IT, however many containers and however many restarts, and a
// failed or skipped send does NOT use the day up (cycle 1, QA-2884).
//   * THE PER-RECIPIENT CLAIM CARRIES EXACTLY-ONCE. It is a document in `job_locks` with _id
//     `digest-sent:<day>:<email>`; the unique _id makes the first claim atomic and a retry is re-taken with
//     one atomic findOneAndUpdate on {status: "retry", attempts < 3, next_at <= now}, so two processes
//     racing for the same claim, first or retry, cannot both win it.
//   * `takeJobLock("daily-digest")` (the same lock the other ticks use) is only an EFFICIENCY guard: it
//     stops two containers each walking the whole recipient list at 21:00. Nothing relies on it for
//     correctness (the suite races ticks with the lock switched off and still gets one mail).
//   * The claim records the outcome. status: "sending" (taken, mail in flight; a crash here leaves it
//     "sending" for good: one mail possibly missed, never two sent) -> "sent" (final, never retried) |
//     "retry" (the send failed or was skipped; a later tick on the SAME IST day retries it, at least 10
//     minutes after the last attempt, up to 3 attempts in all) | "exhausted" (3 attempts used, stop) |
//     "closed" (not a send problem: the address is not an eligible ERP account, or the account's own mail
//     switch is off; recorded once, never retried). The day key means a retry can never run after 23:59 IST.
export const DIGEST_HOUR_IST = 21;
export const DIGEST_MAX_ATTEMPTS = 3;
export const DIGEST_RETRY_GAP_MS = 10 * 60_000;

export type DigestResult = {
  to: string;
  // mailed = handed to the one mail door (sendMail); its own outcome is `status`. ineligible = not an
  // ERP account that may get the digest; silenced = the account's own mail switch is off.
  outcome: "mailed" | "ineligible" | "silenced" | "failed";
  status?: "sent" | "failed" | "skipped";
  reason?: string;
  text?: string;
  attempt?: number;   // 1 for the first send of the day, 2 and 3 for retries (the tick only)
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
// `raw` lets a caller judge a list that is not stored yet (the Defaults route, before it writes it).
export async function resolveRecipients(raw?: string): Promise<Resolved[]> {
  const addrs = parseRecipients(raw ?? (await getDefaults()).digest_recipients);
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

// The durable per-recipient day claim. Returns the attempt number the caller has WON (1 = first send of
// the day, 2..3 = a retry), or 0 when somebody else holds it or it is not due. Both paths are atomic:
// the first is an insert on a unique _id, a retry is one findOneAndUpdate whose filter is the whole
// eligibility test, so of N racers exactly one gets the document back.
async function takeClaim(day: string, to: string, instance: string, now: Date): Promise<number> {
  const col = mongoose.connection.db!.collection("job_locks");
  const _id = `digest-sent:${day}:${to}` as any;
  try {
    await col.insertOne({ _id, day, to, instance, at: now, status: "sending", attempts: 1 });
    return 1;
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
  }
  const won = await col.findOneAndUpdate(
    { _id, status: "retry", attempts: { $lt: DIGEST_MAX_ATTEMPTS }, next_at: { $lte: now } },
    { $set: { status: "sending", instance, at: now }, $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  return Number((won as any)?.attempts ?? 0);
}

// Record how the attempt ended. "sent" is final; a failed or skipped send is retryable until the cap.
async function settleClaim(day: string, to: string, attempt: number, res: DigestResult, at: Date): Promise<void> {
  let set: Record<string, unknown>;
  if (res.outcome === "ineligible" || res.outcome === "silenced") set = { status: "closed" };
  else if (res.status === "sent") set = { status: "sent", sent_at: at };
  else if (attempt >= DIGEST_MAX_ATTEMPTS) set = { status: "exhausted" };
  else set = { status: "retry", next_at: new Date(at.getTime() + DIGEST_RETRY_GAP_MS) };
  await mongoose.connection.db!.collection("job_locks").updateOne(
    { _id: `digest-sent:${day}:${to}` as any },
    { $set: { ...set, last_status: res.status ?? res.outcome, last_reason: res.reason ?? null, last_at: at } },
  );
}

// One scheduler tick. `now` and `instance` are arguments so a test drives the clock without touching the
// process clock; instrumentation passes neither `now` nor a fake instance.
// `skipLock` and `simulate` are for the TEST-ONLY clock door (it 404s outside center_erp_ci* databases):
// `skipLock` proves the claims alone carry exactly-once; `simulate[attempt-1]` replaces the outcome of a
// real send, because every test env suppresses mail so a genuine "sent" or "failed" cannot occur there.
export async function digestTick(opts: { now?: Date; instance?: string; includeText?: boolean; skipLock?: boolean; simulate?: Array<"sent" | "failed" | "skipped"> } = {}): Promise<DigestTickResult> {
  const clock = () => opts.now ?? new Date();
  const now = clock();
  const instance = opts.instance ?? "digest-" + process.pid;
  const day = istDayOf(now);
  if (istMinuteOfDay(now) < DIGEST_HOUR_IST * 60) return { fired: false, day, reason: `before ${DIGEST_HOUR_IST}:00 IST`, results: [] };
  await dbConnect();
  if (!opts.skipLock && !(await takeJobLock("daily-digest", 10 * 60_000, instance))) {
    return { fired: false, day, reason: "another container holds the daily-digest lock", results: [] };
  }
  try {
    const recipients = await resolveRecipients();
    if (!recipients.length) return { fired: false, day, reason: "no recipients configured", results: [] };
    const results: DigestResult[] = [];
    for (const r of recipients) {
      if (istDayOf(clock()) !== day) break;   // a long tick that crosses midnight must not send yesterday's digest
      const attempt = await takeClaim(day, r.to, instance, clock());
      if (!attempt) continue;
      let res: DigestResult;
      try {
        res = await sendOne(day, r, opts.includeText === true);
        const sim = opts.simulate?.[attempt - 1];
        if (sim && res.outcome === "mailed") res.status = sim;
        res.attempt = attempt;
        await settleClaim(day, r.to, attempt, res, clock());
      } catch (e) {
        // Neither step is expected to throw (sendMail catches everything). If one does, do not leave the claim
        // "sending" for the rest of the day: record a failed attempt so the retry rules apply.
        res = { to: r.to, outcome: "failed", status: "failed", reason: e instanceof Error ? e.message : String(e), attempt };
        await settleClaim(day, r.to, attempt, res, clock()).catch(() => {});
      }
      results.push(res);
    }
    if (!results.length) return { fired: false, day, reason: `already handled for ${day}: sent, closed, exhausted, or waiting out the ${DIGEST_RETRY_GAP_MS / 60_000}-minute gap before a retry`, results };
    return { fired: true, day, results };
  } finally {
    // Released as soon as the work is done: the durable claims above, not this lock's TTL, are what stop a second send.
    if (!opts.skipLock) await mongoose.connection.db!.collection("job_locks").deleteOne({ _id: "daily-digest" as any, holder: instance }).catch(() => {});
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
  // Counts come from each send's own outcome (the MailLog status), never from "was handed to the door":
  // a skipped mail (email off, no SES credentials, an ineligible address) must not read as delivered.
  const count = (st: "sent" | "skipped" | "failed") => results.filter((r) => (r.status ?? "failed") === st).length;
  const why = [...new Set(results.filter((r) => r.status !== "sent" && r.reason).map((r) => String(r.reason)))].slice(0, 3);
  return {
    status: 200 as const,
    day,
    attempted: results.length,
    sent: count("sent"),
    skipped: count("skipped"),
    failed: count("failed"),
    ineligible: results.filter((r) => r.outcome === "ineligible").length,
    not_sent_reasons: why,
    results,
  };
}
