import mongoose from "mongoose";
import { MailLog, User } from "@/models";
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
//   * A claim left "sending" by a crash is re-taken after DIGEST_SENDING_STALE_MS (15 minutes) by the SAME
//     atomic re-take, and counts as an attempt inside the 3-attempt cap (cycle 2, checker A3). The trade-off
//     is a rare possible double send (a send that was only slow, not dead, and finishes after the 15 minutes)
//     in exchange for never losing the day to a crash. The claim key is the NORMALISED LOWERCASE EMAIL.
//
// RECIPIENTS (cycle 2, Umesh 2026-10-07: "a custom list ... select it or add custom mail"). `digest_recipients`
// stays ONE string in Defaults, but each entry is tagged: `u:<24-hex ERP user id>` (a picked account, so a
// renamed or re-emailed user keeps receiving it) or a typed email address. A legacy plain-email string reads as
// typed entries, no data lost. Who sees what:
//   * an ERP account (picked, or a typed address that IS an account's email: the ACCOUNT WINS) gets that
//     account's own view: its centre scope, and money only with finance.view. An ineligible account (Trainer,
//     deactivated, dropped, awaiting approval) is refused, never "upgraded" to a full view by typing its email.
//   * a typed address that matches NO account gets the FULL report including money (Umesh, AskUserQuestion
//     2026-10-07): an Admin-shaped, unscoped viewer plus `dailyDigest(..., {fullView: true})`. Only a holder of
//     defaults.manage with can_edit (Admin by default; the right is grantable, Rule 40) can add one, and the screen warns "This address will receive cost figures".
export const DIGEST_HOUR_IST = 21;
export const DIGEST_MAX_ATTEMPTS = 3;
export const DIGEST_RETRY_GAP_MS = 10 * 60_000;
export const DIGEST_SENDING_STALE_MS = 15 * 60_000;
export const DIGEST_MAX_RECIPIENTS = 50;

export type DigestResult = {
  to: string;
  // mailed = handed to the one mail door (sendMail); its own outcome is `status`. ineligible = not an
  // ERP account that may get the digest; silenced = the account's own mail switch is off.
  outcome: "mailed" | "ineligible" | "silenced" | "failed";
  status?: "sent" | "failed" | "skipped";
  reason?: string;
  text?: string;
  kind?: "user" | "address";   // a picked/typed ERP account, or a typed address
  full?: boolean;     // a typed address with no account: it got the full view, money included
  attempt?: number;   // 1 for the first send of the day, 2 and 3 for retries (the tick only)
};
export type DigestTickResult = { fired: boolean; day: string; reason?: string; warning?: string; results: DigestResult[] };

export const DIGEST_ONLY_NOBODY = "Digest-only is ON but no one can receive the digest, so the approval mails are currently going nowhere. Add an active recipient under Admin, Defaults, or switch digest-only off.";

export type RecipientEntry = { kind: "user"; id: string } | { kind: "address"; email: string };
const USER_TAG = /^u:([0-9a-f]{24})$/;
// Deliberately narrower than RFC 5322: ASCII letters, digits and . _ + - in the local part, a dotted domain.
// Nothing that could end a header line or open a second address (no space, quote, angle bracket, comma, colon).
const EMAIL_RE = /^[a-z0-9._+-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const isValidTypedAddress = (e: string) => e.length <= 254 && EMAIL_RE.test(e);

// LENIENT read of the stored string (a legacy value may hold newlines or semicolons): tokens are lowercased,
// deduplicated, and tagged `u:<id>` -> a user entry, anything else -> a typed address.
export function parseEntries(raw: unknown): RecipientEntry[] {
  const seen = new Set<string>();
  const out: RecipientEntry[] = [];
  for (const part of String(raw ?? "").split(/[,;\s]+/)) {
    const t = part.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const m = USER_TAG.exec(t);
    out.push(m ? { kind: "user", id: m[1] } : { kind: "address", email: t });
  }
  return out;
}
export const entryToken = (e: RecipientEntry) => (e.kind === "user" ? `u:${e.id}` : e.email);

// STRICT check of a list being WRITTEN (the Defaults route). A blank string is a valid "clear the list". Anything
// else must hold at least one entry, every entry must be a tag or a syntactically valid address, no duplicates,
// at most DIGEST_MAX_RECIPIENTS, and no control character anywhere: CR/LF or NUL in an address is how a header
// gets injected into a mail (a second To/Bcc line), so it is refused outright rather than split into tokens.
export function validateRecipientList(raw: string): { ok: true; entries: RecipientEntry[]; canonical: string } | { ok: false; error: string } {
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(raw)) return { ok: false, error: "The recipient list holds a line break or another control character. Separate recipients with commas, on one line." };
  if (!raw.trim()) return { ok: true, entries: [], canonical: "" };
  const tokens = raw.split(/[,;\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return { ok: false, error: "The recipient list has separators but no recipient. Clear it, or add an email address or an ERP user." };
  if (tokens.length > DIGEST_MAX_RECIPIENTS) return { ok: false, error: `A digest list holds at most ${DIGEST_MAX_RECIPIENTS} recipients; this one has ${tokens.length}.` };
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!USER_TAG.test(t) && !isValidTypedAddress(t)) return { ok: false, error: `"${t.slice(0, 80)}" is not a valid email address.` };
    if (seen.has(t)) return { ok: false, error: `"${t}" is listed twice.` };
    seen.add(t);
  }
  const entries = parseEntries(tokens.join(","));
  return { ok: true, entries, canonical: entries.map(entryToken).join(", ") };
}

export type Resolved = {
  to: string;                       // the normalised lowercase email: the mail address AND the claim key
  kind: "user" | "address";
  viewer: SessionUser | null;       // null = nobody to render for (ineligible)
  full?: boolean;                   // true = a typed address that matches no ERP account: the full view, money included
  problem?: string;
  silenced?: string;
};
export const PROBLEM_USER_GONE = "this ERP user no longer exists";
export const PROBLEM_INACTIVE = "this ERP account is deactivated, dropped or awaiting approval";
export const PROBLEM_TRAINER = "Trainer accounts are not sent the daily digest";
export const PROBLEM_BAD_ADDRESS = "not a valid email address";
export const isDeliverable = (r: Resolved) => !!r.viewer && !r.silenced;

// Recipients -> who is mailed, and as whom. The finance section and the centre scope are decided by the ACCOUNT's
// own permission, so an account always keeps its own view; only an address that is no account at all has no
// permission to read and is given the full view by the Admin's explicit choice. Each problem is returned (and
// written to the MailLog by the caller) rather than dropped, so "why did X not get it?" is answerable.
// `raw` lets a caller judge a list that is not stored yet (the Defaults route, before it writes it).
export async function resolveRecipients(raw?: string): Promise<Resolved[]> {
  const entries = parseEntries(raw ?? (await getDefaults()).digest_recipients);
  if (!entries.length) return [];
  const ids = entries.filter((e): e is { kind: "user"; id: string } => e.kind === "user").map((e) => e.id);
  const addrs = entries.filter((e): e is { kind: "address"; email: string } => e.kind === "address").map((e) => e.email);
  const or: any[] = [];
  if (ids.length) or.push({ _id: { $in: ids } });
  if (addrs.length) or.push({ email: { $in: addrs } }, { dropped_email: { $in: addrs } });
  const users = await User.find({ $or: or }).select("name email dropped_email role location_scope can_edit active dropped approval_status mail_enabled").lean<any[]>();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  // A dropped account's login email was renamed ("dropped.<ts>.<email>"); its original is in dropped_email. Index both, the
  // live email winning, so a typed copy of a dropped person's address finds the (refused) account instead of "no account".
  const byEmail = new Map<string, any>();
  for (const u of users) if (u.dropped_email) byEmail.set(String(u.dropped_email).toLowerCase(), u);
  for (const u of users) byEmail.set(String(u.email).toLowerCase(), u);
  const asAccount = (u: any, kind: "user" | "address", toOverride?: string): Resolved => {
    const to = toOverride ?? String(u.email).toLowerCase();
    if (u.active === false || u.dropped === true || u.approval_status === "Pending" || u.approval_status === "Rejected") return { to, kind, viewer: null, problem: PROBLEM_INACTIVE };
    if (u.role === "Trainer") return { to, kind, viewer: null, problem: PROBLEM_TRAINER };
    return {
      to, kind,
      viewer: { id: String(u._id), name: u.name, email: to, role: u.role, location_scope: (u.location_scope ?? []).map(String), can_edit: !!u.can_edit },
      silenced: suppressFor(u),
    };
  };
  const out: Resolved[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    let r: Resolved;
    if (e.kind === "user") {
      const u = byId.get(e.id);
      r = u ? asAccount(u, "user") : { to: `u-${e.id}@user-removed.invalid`, kind: "user", viewer: null, problem: PROBLEM_USER_GONE };   // a well-formed placeholder so the MailLog row carries the reason
    } else {
      const u = byEmail.get(e.email);
      if (u) r = asAccount(u, "address", e.email);                                  // the ACCOUNT WINS over a typed address
      else if (!isValidTypedAddress(e.email)) r = { to: e.email, kind: "address", viewer: null, problem: PROBLEM_BAD_ADDRESS };
      else r = {
        to: e.email, kind: "address", full: true,
        // an Admin-shaped, unscoped viewer: locationFilter/isScoped see no centre limit. Its money comes from
        // `fullView`, not from any permission it holds (it has none).
        viewer: { id: "digest-typed-address", name: e.email, email: e.email, role: "Admin", location_scope: [], can_edit: false },
      };
    }
    if (seen.has(r.to)) continue;                                           // one mail per address, however it was listed
    seen.add(r.to);
    out.push(r);
  }
  return out;
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
    `Enrolled: ${c.enrolled.total} (new enrolments on the day)`,
    `Training started on the day: ${c.training_started.total}`,
    `Current learners (measured ${c.current.measured_at}): ${c.current.enrolled} enrolled, ${c.current.training_ongoing} Training Ongoing. These are current totals, not historical snapshots.`,
    ...(c.training_started.exceptions.missing_actual_start || c.training_started.exceptions.missing_join_date
      ? [`Training-date exceptions (position now): ${c.training_started.exceptions.missing_actual_start} candidates missing an actual batch start, ${c.training_started.exceptions.missing_join_date} missing a roster joining date.`]
      : []),
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
    d.live_note,
  ];
  return renderMail({
    title: `Daily digest, ${d.day}`,
    lines,
    cta: { label: "Open the daily digest", url: `https://www.vidysea.com/erp/reports/daily?date=${d.day}` },
  });
}

async function sendOne(day: string, r: Resolved, includeText: boolean): Promise<DigestResult> {
  return { ...(await sendOneInner(day, r, includeText)), kind: r.kind, ...(r.full ? { full: true } : {}) };
}
async function sendOneInner(day: string, r: Resolved, includeText: boolean): Promise<DigestResult> {
  const base = { to: r.to, subject: digestSubject(day), entity: "DailyDigest", html: "", text: "" };
  if (r.problem || !r.viewer) {
    const o = await sendMail({ ...base, suppress: r.problem ?? PROBLEM_INACTIVE });
    return { to: r.to, outcome: "ineligible", status: o.status, reason: o.reason };
  }
  let content: { html: string; text: string };
  try {
    content = digestMailContent(await dailyDigest(day, r.viewer, r.full ? { fullView: true } : undefined));
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
  // A retry, OR a claim stuck in "sending" past DIGEST_SENDING_STALE_MS (the process that took it died): either
  // way ONE atomic findOneAndUpdate whose filter is the whole eligibility test, and it counts as an attempt.
  const won = await col.findOneAndUpdate(
    {
      _id, attempts: { $lt: DIGEST_MAX_ATTEMPTS },
      $or: [
        { status: "retry", next_at: { $lte: now } },
        { status: "sending", at: { $lte: new Date(now.getTime() - DIGEST_SENDING_STALE_MS) } },
      ],
    },
    { $set: { status: "sending", instance, at: now }, $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  return Number((won as any)?.attempts ?? 0);
}

// Record how the attempt ended. "sent" is final; a failed or skipped send is retryable until the cap.
// Conditional on the holder: a slow original sender whose claim was re-taken after 15 minutes (the stale rule) must not
// overwrite the re-taker's state (a late "retry" over a "sent" would bring a third mail). Nothing matched = not ours any more.
async function settleClaim(day: string, to: string, attempt: number, instance: string, res: DigestResult, at: Date): Promise<void> {
  let set: Record<string, unknown>;
  if (res.outcome === "ineligible" || res.outcome === "silenced") set = { status: "closed" };
  else if (res.status === "sent") set = { status: "sent", sent_at: at };
  else if (attempt >= DIGEST_MAX_ATTEMPTS) set = { status: "exhausted" };
  else set = { status: "retry", next_at: new Date(at.getTime() + DIGEST_RETRY_GAP_MS) };
  await mongoose.connection.db!.collection("job_locks").updateOne(
    { _id: `digest-sent:${day}:${to}` as any, instance, attempts: attempt, status: "sending" },
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
    // A2 (checker A, cycle 1): digest-only is ON, yet nobody on the list can receive the digest any more (the last
    // one was deactivated, or became a Trainer): every cost-approval mail is being suppressed and nothing replaces
    // it. Say so ON THE RECORD, once per IST day (a claim, so two containers write one row), and in the result.
    let warning: string | undefined;
    if ((await getDefaults()).digest_only_approval_mails === true && !recipients.some(isDeliverable)) {
      warning = DIGEST_ONLY_NOBODY;
      const claimed = await mongoose.connection.db!.collection("job_locks").insertOne({ _id: `digest-warn:${day}` as any, day, instance, at: now }).then(() => true, (e: any) => { if (e?.code === 11000) return false; throw e; });
      if (claimed) await MailLog.create({ to: "(daily digest: no deliverable recipient)", subject: `Daily digest ${day}: digest-only is ON with nobody to send it to`, status: "skipped", entity: "DailyDigestWarning", reason: DIGEST_ONLY_NOBODY }).catch(async () => { await mongoose.connection.db!.collection("job_locks").deleteOne({ _id: `digest-warn:${day}` as any }).catch(() => {}); });   // a failed log write must not use up the day's warning
    }
    if (!recipients.length) return { fired: false, day, reason: "no recipients configured", ...(warning ? { warning } : {}), results: [] };
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
        await settleClaim(day, r.to, attempt, instance, res, clock());
      } catch (e) {
        // Neither step is expected to throw (sendMail catches everything). If one does, do not leave the claim
        // "sending" for the rest of the day: record a failed attempt so the retry rules apply.
        res = { to: r.to, outcome: "failed", status: "failed", reason: e instanceof Error ? e.message : String(e), attempt };
        await settleClaim(day, r.to, attempt, instance, res, clock()).catch(() => {});
      }
      results.push(res);
    }
    if (!results.length) return { fired: false, day, reason: `already handled for ${day}: sent, closed, exhausted, or waiting out the ${DIGEST_RETRY_GAP_MS / 60_000}-minute gap before a retry`, ...(warning ? { warning } : {}), results };
    return { fired: true, day, ...(warning ? { warning } : {}), results };
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
  // At least one reason per CATEGORY (cycle 2, checker A5): the account problems (Trainer, deactivated, gone), the
  // person's own mail switch, a failed send and the mail door's own skip (email off, no credentials, test env) are
  // different things to fix, so a long list of one cannot crowd the others out. Up to 3 distinct reasons each.
  const why: string[] = [];
  for (const cat of ["ineligible", "silenced", "failed", "mailed"] as const) {
    const rs_ = [...new Set(results.filter((r) => r.outcome === cat && r.status !== "sent" && r.reason).map((r) => String(r.reason)))].slice(0, 3);
    why.push(...rs_);
  }
  const typed = results.filter((r) => r.kind === "address" && r.full).length;
  return {
    status: 200 as const,
    day,
    attempted: results.length,
    sent: count("sent"),
    skipped: count("skipped"),
    failed: count("failed"),
    ineligible: results.filter((r) => r.outcome === "ineligible").length,
    not_sent_reasons: [...new Set(why)],
    typed_addresses: typed,
    results,
  };
}

// What the screens need to say "nobody can receive this" (checker A2): the stored list's size, how many of its
// recipients could actually be mailed right now, and whether digest-only is ON. One resolve, the tick's own.
export async function digestHealth() {
  const d = await getDefaults();
  const resolved = await resolveRecipients(String(d.digest_recipients ?? ""));
  const deliverable = resolved.filter(isDeliverable).length;
  const digest_only = d.digest_only_approval_mails === true;
  return { digest_only, recipients: resolved.length, deliverable, digest_only_nobody: digest_only && deliverable === 0 };
}
