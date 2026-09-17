// The archive/restore logic for a single candidate, extracted so the single-row DELETE door
// (src/app/api/candidates/[id]/route.ts) and the bulk doors (bulk-archive, bulk-unarchive,
// [id]/unarchive) call the SAME code rather than growing a second copy that drifts — the
// "second copy did not get the fix" failure ARCHITECTURE.md section 3 exists to warn about.
import { AuditLog, BatchMember, Candidate, CandidateDocument, CandidateResult, GovtAttendanceRow, MailLog, SheetChange } from "@/models";
import { HttpError } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { purgedRowMarkers } from "@/lib/tab-mapping";

// QA-1792/QA-1800, unchanged behavior, just relocated: erasure stays impossible either way;
// only the question "can this person be archived at all" is gated. A candidate with batch
// history is archived only with an explicit confirm_batch_history acknowledgement, recorded
// in the audit line so the trail says the operator was told.
export async function archiveCandidate(c: any, user: { id: string }, opts: { reason?: string; confirmBatchHistory?: boolean }) {
  const hasHistory = await BatchMember.exists({ candidate: c._id });
  if (hasHistory && !opts.confirmBatchHistory) {
    throw new HttpError(409, `${c.name} has batch history — confirm to archive anyway (their batch record stays; only the candidate is archived).`);
  }
  const reason = String(opts.reason ?? "").trim();
  c.set({ archived_at: new Date(), archive_reason: reason || null, archived_by: user.id });
  await c.save();
  await audit({
    entity: "Candidate", entityId: c._id, field: "archived_at",
    newValue: `archived${reason ? ` — ${reason.slice(0, 120)}` : " (no reason given)"}${hasHistory ? " (had batch history, confirmed)" : ""}`,
    actor: user.id,
  });
  return { archived_at: c.archived_at, reason: reason || null };
}

export async function unarchiveCandidate(c: any, user: { id: string }) {
  if (!c.archived_at) throw new HttpError(400, `${c.name} is not archived.`);
  c.set({ archived_at: null, archive_reason: null, archived_by: null });
  await c.save();
  await audit({ entity: "Candidate", entityId: c._id, field: "archived_at", newValue: "restored", actor: user.id });
}

// ---- Sub-unit D (qa-candidates-purge): candidates.purge — the ONE code path that erases a Candidate ----
// This DELIBERATELY reverses QA-1792's "delete is archive-only" for a narrow case, on Umesh's approval
// (qa/specs/manish-delete-surfaces.md section 9, 2026-09-17): archived, provably empty, a required
// reason, no recovery window, a PII-masked snapshot in the audit trail. It lives beside archive on
// purpose - one file answers "what can happen to a candidate record" - and it is reached ONLY through
// POST /api/candidates/[id]/purge, never through the archive DELETE (a mode flag on that door is how
// the QA-1792 class of bug comes back).
//
// Every precondition is a query against a model that really holds a `candidate` reference
// (models/index.ts: BatchMember :923, CandidateResult :1108, GovtAttendanceRow :1035,
// CandidateDocument :636). Two conditions from the spec's list have NO query of their own, and that
// is stated rather than silently passed:
//   - attendance: DailyLog.present_member_ids holds BatchMember ids, never Candidate ids, so it is
//     reachable only through a BatchMember row - which the batch-history check already refuses;
//   - cost links: CostEntry has no candidate field at all (batch/trainer/location only).
export type PurgeBlocker = { key: "not_archived" | "batch_history" | "results" | "govt_rows" | "documents"; message: string };

export async function purgeBlockers(c: any): Promise<PurgeBlocker[]> {
  const out: PurgeBlocker[] = [];
  if (!c.archived_at) {
    out.push({ key: "not_archived", message: `${c.name} is not archived. Archive the candidate first - only an archived record can be permanently deleted.` });
  }
  const [members, results, govtRows, docs] = await Promise.all([
    BatchMember.countDocuments({ candidate: c._id }),
    CandidateResult.countDocuments({ candidate: c._id }),
    GovtAttendanceRow.countDocuments({ candidate: c._id }),
    CandidateDocument.countDocuments({ candidate: c._id }),
  ]);
  if (members > 0) {
    out.push({ key: "batch_history", message: `${c.name} has batch history (on ${members} batch roster${members === 1 ? "" : "s"}, current or past). A person with batch history is kept archived, never permanently deleted.` });
  }
  if (results > 0) {
    out.push({ key: "results", message: `${c.name} has ${results} recorded result${results === 1 ? "" : "s"}. A candidate with results cannot be permanently deleted.` });
  }
  if (govtRows > 0) {
    out.push({ key: "govt_rows", message: `${c.name} is linked to ${govtRows} government attendance row${govtRows === 1 ? "" : "s"}. A candidate matched to portal attendance cannot be permanently deleted.` });
  }
  if (docs > 0) {
    out.push({ key: "documents", message: `${c.name} still has ${docs} document${docs === 1 ? "" : "s"} on file. Remove each document first - permanent delete does not remove documents.` });
  }
  return out;
}

// "J. K." from "Junk Kumar". The audit trail must say WHICH record went without becoming a copy of
// the person (audit.ts's own warning: "the audit trail becoming the leak"). No Aadhaar, APAAR, portal
// id, email, parent names or address - nothing a second collection should hold forever.
function initials(name: unknown): string {
  return String(name ?? "").trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + ".").join(" ");
}
// ---- QA-2774 (Umesh, spec section 10): at purge, the person's EARLIER history is masked too ----
// Cycle 1 masked only the new purge row, while every earlier AuditLog row kept the full phone (old and new),
// the father's name, the email and the archive reason, and GET /api/audit/Candidate/<id> kept serving them -
// under a Drawer that promised "only a masked summary". Umesh's ruling: mask it all, keep who / when / which
// field. So a row's `field`, `actor`, `actor_type` and `created_at` are never touched; only the VALUES change.
//
// Two mechanisms, because PII reaches history two ways:
//   1. by FIELD - a row whose `field` is a PII field has its old/new value masked by kind (below);
//   2. by VALUE - free text (an archive reason, a sheet row label, a mail subject) can carry the name or phone
//      under any field name, so every other string is scrubbed of every value this person has EVER held
//      (current record + every earlier PII value in the trail), plus phone- and email-shaped text.
// Kinds: initials keep "which record" legible the way the snapshot does; phones keep the last 4 like the
// snapshot; government ids keep a ****1234 tail like audit.ts's aadhaar mask; the rest become a marker.
const MASKED = "(masked on purge)";
type PiiKind = "initials" | "phone" | "tail4" | "hidden";
export const CANDIDATE_PII_FIELDS: Record<string, PiiKind> = {
  name: "initials", father_name: "initials", mother_name: "initials", salutation: "hidden",
  phone: "phone", alt_phone: "phone",
  email: "hidden",
  aadhaar_no: "tail4", apaar_id: "tail4", id_reference: "tail4", sidh_candidate_id: "tail4",
  dob: "hidden", gender: "hidden", marital_status: "hidden", religion: "hidden", social_category: "hidden",
  differently_abled: "hidden", address_type: "hidden", custom_fields: "hidden",
};

function maskByKind(kind: PiiKind, v: unknown): unknown {
  if (v === null || v === undefined || v === "") return v; // absent stays absent (audit.ts's rule)
  if (kind === "initials") return initials(v);
  if (kind === "phone") {
    const d = String(v).replace(/\D/g, "");
    return d.length >= 4 ? "******" + d.slice(-4) : "******"; // idempotent: "******1234" stays itself
  }
  if (kind === "tail4") {
    const t = String(v);
    return t.length <= 4 ? "****" : "****" + t.slice(-4);
  }
  return MASKED;
}

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OBJECT_ID = /^[0-9a-f]{24}$/i;
// Scrubs one person's identifiers out of any value. `needles` = every raw string this person has held.
export function scrubPii(v: unknown, needles: string[]): unknown {
  if (typeof v === "string") {
    if (OBJECT_ID.test(v)) return v;
    let out = v;
    for (const n of needles) {
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, "giu"), "[masked]");
    }
    return out
      .replace(/[^\s@"'<>()]+@[^\s@"'<>()]+\.[^\s@"'<>()]+/g, "[masked]")
      .replace(/(?<![0-9A-Za-z])(?:\+?91[\s-]?)?\d{5}[\s-]?\d{5}(?![0-9A-Za-z])/g, "[masked]")
      .replace(/(?<![0-9A-Za-z])\d{8,}(?![0-9A-Za-z])/g, "[masked]");
  }
  if (Array.isArray(v)) return v.map((x) => scrubPii(x, needles));
  if (v && typeof v === "object" && !(v instanceof Date) && (v as any).constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      // A purge row's sheet_keys are HMACs, not PII - and a hex digest can contain an 8-digit run.
      out[k] = k === "sheet_keys" ? x : CANDIDATE_PII_FIELDS[k] ? maskByKind(CANDIDATE_PII_FIELDS[k], x) : scrubPii(x, needles);
    }
    return out;
  }
  return v;
}

const NEEDLE_FIELDS = ["name", "father_name", "mother_name", "email", "phone", "alt_phone", "aadhaar_no", "apaar_id", "id_reference", "sidh_candidate_id"];
function addNeedles(set: Set<string>, field: string, v: unknown) {
  if (typeof v !== "string" && typeof v !== "number") return;
  const t = String(v).trim();
  if (t.length < 3) return;
  set.add(t);
  if (field === "phone" || field === "alt_phone") { const d = t.replace(/\D/g, ""); if (d.length >= 10) set.add(d.slice(-10)); }
  if (field === "name" || field === "father_name" || field === "mother_name") {
    for (const w of t.split(/\s+/)) if (w.length >= 3) set.add(w);
  }
}

// Everything that remembers this person besides the record itself. Read-only.
async function candidateHistory(c: any) {
  const id = c._id;
  const [auditRows, sheetRows] = await Promise.all([
    AuditLog.find({ entity: "Candidate", entity_id: id, field: { $ne: "purged" } }).lean<any[]>(),
    SheetChange.find({ entity_type: "Candidate", entity: id }).lean<any[]>(),
  ]);
  const needles = new Set<string>();
  const valuesByField: Record<string, unknown[]> = {};
  const remember = (field: string, v: unknown) => {
    if (!NEEDLE_FIELDS.includes(field) || v === null || v === undefined) return;
    if (typeof v === "string" && (v.trim().startsWith("****") || v.trim() === MASKED)) return; // already masked
    addNeedles(needles, field, v);
    (valuesByField[field] ??= []).push(v);
  };
  for (const f of NEEDLE_FIELDS) remember(f, c[f]);
  for (const r of auditRows) { remember(String(r.field ?? ""), r.old_value); remember(String(r.field ?? ""), r.new_value); }
  for (const r of sheetRows) {
    const f = String(r.field_name ?? "");
    remember(f, r.old_value); remember(f, r.new_value);
    remember(f, r.impact_snapshot?.apply); remember(f, r.impact_snapshot?.revert);
    remember("name", r.impact_snapshot?.row_label);
  }
  // Mail about this candidate, plus the OTP mail/SMS sent to any address they have held (entity PublicToken,
  // no entity_id - sent before the record existed). Deliberately NOT every row to that address: a staff user
  // who happens to share it keeps their own mail history.
  const addresses = new Set<string>();
  for (const v of valuesByField.email ?? []) { const t = String(v ?? "").trim(); if (/@/.test(t)) addresses.add(t); }
  const phones = new Set<string>();
  for (const f of ["phone", "alt_phone"]) for (const v of valuesByField[f] ?? []) {
    const d = String(v ?? "").replace(/\D/g, "");
    if (d.length >= 10) { const p = d.slice(-10); for (const shape of [p, "+91" + p, "91" + p, "0" + p]) phones.add(shape); }
  }
  const toMatch: any[] = [...addresses].map((a) => ({ to: new RegExp(`^\\s*${esc(a)}\\s*$`, "i") }));
  if (phones.size) toMatch.push({ to: { $in: [...phones] } });
  const mailRows = await MailLog.find({ $or: [
    { entity: "Candidate", entity_id: id },
    ...toMatch.map((m) => ({ entity: { $in: ["Candidate", "PublicToken"] }, ...m })),
  ] }).lean<any[]>();
  // Longest first, so "Asha Devi" is masked whole before "Asha" can split it.
  return { auditRows, mailRows, sheetRows, needles: [...needles].sort((a, b) => b.length - a.length), valuesByField };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const valueMask = (field: string, v: unknown, needles: string[]) =>
  CANDIDATE_PII_FIELDS[field] ? maskByKind(CANDIDATE_PII_FIELDS[field], v) : scrubPii(v, needles);

// Masks every earlier row in place. Idempotent - masking a masked row changes nothing - so the purge runs it
// twice (before and after the delete) and a retry can run it again.
async function maskCandidateHistory(h: Awaited<ReturnType<typeof candidateHistory>>) {
  const { needles } = h;
  for (const r of h.auditRows) {
    const f = String(r.field ?? "");
    const oldV = valueMask(f, r.old_value, needles), newV = valueMask(f, r.new_value, needles);
    if (same(oldV, r.old_value) && same(newV, r.new_value)) continue;
    await AuditLog.updateOne({ _id: r._id }, { $set: { old_value: oldV ?? null, new_value: newV ?? null } });
  }
  for (const r of h.mailRows) {
    const set = {
      // Every address is masked; only the mailer's own "(no address on record)" placeholder is left as it is.
      to: r.channel === "sms" ? maskByKind("phone", r.to) : /^\(no .* on record\)$/.test(String(r.to ?? "")) ? r.to : MASKED,
      subject: scrubPii(r.subject, needles), reason: scrubPii(r.reason, needles),
    };
    if (same(set.to, r.to) && same(set.subject, r.subject) && same(set.reason, r.reason)) continue;
    await MailLog.updateOne({ _id: r._id }, { $set: set });
  }
  for (const r of h.sheetRows) {
    const f = String(r.field_name ?? "");
    const snap = r.impact_snapshot && typeof r.impact_snapshot === "object"
      ? { ...(scrubPii(r.impact_snapshot, needles) as any), apply: valueMask(f, r.impact_snapshot.apply, needles), revert: valueMask(f, r.impact_snapshot.revert, needles) }
      : r.impact_snapshot;
    const set = { old_value: valueMask(f, r.old_value, needles), new_value: valueMask(f, r.new_value, needles), note: scrubPii(r.note, needles), impact_snapshot: snap };
    if (same(set.old_value, r.old_value) && same(set.new_value, r.new_value) && same(set.note, r.note) && same(set.impact_snapshot, r.impact_snapshot)) continue;
    await SheetChange.updateOne({ _id: r._id }, { $set: set });
  }
}

export function maskedCandidateSnapshot(c: any, needles: string[] = []) {
  const phone = String(c.phone ?? "").replace(/\D/g, "");
  return {
    name_initials: initials(c.name),
    phone_last4: phone ? "******" + phone.slice(-4) : null,
    location: c.location ? String(c.location?._id ?? c.location) : null,
    program: c.program ? String(c.program?._id ?? c.program) : null,
    lifecycle_status: c.lifecycle_status ?? null,
    created_at: c.createdAt ?? null,
    archived_at: c.archived_at ?? null,
    // QA-2774: free text an operator typed. Cycle 1 copied it verbatim, and in the checker's run it held the
    // full name and the old phone. Scrubbed of this person's identifiers, kept otherwise ("duplicate lead").
    archive_reason: c.archive_reason ? scrubPii(String(c.archive_reason), needles) : null,
    archived_by: c.archived_by ? String(c.archived_by) : null,
  };
}

// ORDER (QA-2774 cycle 2). Whatever fails, the record must never be GONE while its history is unmasked, gone
// without its purge row, or gone without its sheet marker (QA-2775: a gone-but-unmarked lead comes back from the
// sheet). Mongo here is a standalone - no transactions - so the order IS the guarantee:
//   1. refuse (reason, typed name, preconditions)             - writes nothing
//   2. read the history and build the needles                 - writes nothing
//   3. write the purge row (masked snapshot + sheet markers)  - if this throws, nothing has changed at all.
//      Cycle 1 audited AFTER the delete, so a throwing audit() left the record gone with no row.
//   4. mask the earlier history                               - the record still exists
//   5. delete, conditional on still being archived
//   6. mask again, to catch a row written between 2 and 5. Idempotent and best-effort: the record is gone,
//      and step 4 already covered everything that existed when the operator confirmed.
// A failure in 4 or 5 renames the purge row to "purge_aborted" (the sheet ingest reads only "purged") and
// rethrows. That leaves a still-existing archived record whose history is (partly) masked - the safe direction:
// detail lost from the trail of a record already chosen for erasure, never PII left behind a deleted one.
export async function purgeCandidate(c: any, user: { id: string }, opts: { reason?: unknown; confirmName?: unknown }) {
  const reason = String(opts.reason ?? "").trim();
  if (!reason) throw new HttpError(400, "A reason is required to permanently delete a candidate.");
  if (String(opts.confirmName ?? "").trim() !== String(c.name ?? "").trim()) {
    throw new HttpError(400, `Type the candidate's name exactly as shown (${c.name}) to confirm the permanent delete.`);
  }
  const blockers = await purgeBlockers(c);
  if (blockers.length) {
    const err = new HttpError(409, blockers.map((b) => b.message).join(" "));
    throw err;
  }
  const history = await candidateHistory(c);
  const snapshot = { ...maskedCandidateSnapshot(c, history.needles), sheet_keys: purgedRowMarkers("Candidate", history.valuesByField) };
  await audit({
    entity: "Candidate", entityId: c._id, field: "purged",
    oldValue: snapshot,
    newValue: `permanently deleted - ${scrubPii(reason.slice(0, 300), history.needles)}`,
    actor: user.id,
  });
  const abort = () => AuditLog.updateMany({ entity: "Candidate", entity_id: c._id, field: "purged" }, { $set: { field: "purge_aborted" } }).catch(() => {});
  let del: { deletedCount?: number };
  try {
    await maskCandidateHistory(history);
    // Conditional on still being archived, so a restore landing between the check and the delete cannot be
    // overtaken. The other preconditions are check-then-act; disclosed in the unit manifest.
    del = await Candidate.deleteOne({ _id: c._id, archived_at: { $ne: null } });
  } catch (e) {
    await abort();
    throw e;
  }
  if (del.deletedCount !== 1) {
    await abort();
    throw new HttpError(409, `${c.name} changed while you were confirming - reload and try again.`);
  }
  try {
    await maskCandidateHistory(await candidateHistory(c));
  } catch (e) {
    // Not silent (senior review, cycle 2): the purge row itself says the second pass did not complete, so the
    // state is discoverable from the trail. Only rows written in the race window between steps 2 and 5 can be
    // affected. The marker write can fail for the same reason the pass did; that residual is disclosed.
    console.error("[purge] post-delete history re-mask failed", String(c._id), e);
    await AuditLog.updateMany({ entity: "Candidate", entity_id: c._id, field: "purged" }, { $set: { "old_value.history_remask_incomplete": true } }).catch(() => {});
  }
  return { purged: true };
}
