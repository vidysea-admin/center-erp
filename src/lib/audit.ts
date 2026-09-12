import { AuditLog } from "@/models";

type ActorType = "USER" | "SYSTEM" | "AUTOMATION" | "EXTERNAL_SYNC";

// Every write goes through this (spec §2 AuditLog). Call once per changed field,
// or with field=undefined for create/delete events.
export async function audit(opts: {
  entity: string;
  entityId: unknown;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  actor?: string | null;
  actorType?: ActorType;
}) {
  // QA-1062 cycle 2 (2026-08-25): the masking used to live ONLY in auditDiff, so every DIRECT
  // audit() call wrote the raw value — including aadhaar_no, the field the mask was built for.
  // A checker reached a live tc_password through exactly that: the Sync Inbox revert door calls
  // audit() directly, and a non-Admin read both passwords out of the trail while the list route's
  // mask worked perfectly. Adding a field to a set that half the callers never consult is the
  // guard-that-cannot-fire shape (QA-696's family), and it is why this moved DOWN here: one
  // masking site, on the path every caller uses, rather than a rule the next caller must remember.
  const field = opts.field ?? "";
  await AuditLog.create({
    entity: opts.entity,
    entity_id: opts.entityId,
    field: opts.field,
    old_value: maskSensitive(field, opts.oldValue) ?? null,
    new_value: maskSensitive(field, opts.newValue) ?? null,
    actor: opts.actor ?? null,
    actor_type: opts.actorType ?? "USER",
  });
}

// Diff two plain objects and audit each changed field.
// QA-2506/QA-2508: THE ONE DEFINITION OF "CHANGED", because there were two and they disagreed inside a
// single request. `auditDiff` compared before-vs-after and wrote a row only for a field that really
// moved. `notifyCostCorrection` (approvals.ts) took `Object.keys(patch)` - WHAT WAS SENT - and the
// cost form posts its whole payload every time. So editing only the date told the money approvers
// that the amount had changed: a false alarm on the one control this project treats as load-bearing,
// and the -305 public release note quoted that wrong half as a feature ("the message names which
// fields changed"). Measured before it shipped: 5 fields named, 2 actually changed.
//
// Exported and consumed by BOTH, so the two cannot drift apart again - the same shape as
// QA-2495's shared snapshot type. A second definition of a word is how one of them goes wrong.
// QA-2510: A STORED DATE AND WHAT AN `<input type="date">` POSTS ARE NEVER JSON-EQUAL, so before
// this the word "changed" was wrong about `entry_date` on EVERY save of EVERY cost entry - including
// a row created through the form and saved again without touching a single control. The money
// approvers were told "changed: entry_date" for a correction that did not happen. Found by a checker
// driving the real product; an earlier peer probe reported the opposite because it posted an
// API-shaped payload whose date happened to round-trip, which is exactly why "I sent a request" and
// "a person used the screen" are different measurements.
//
// THE COMPARISON THAT IS ACTUALLY RIGHT is not "do these look the same" and not "are these the same
// calendar day in some timezone" - both of those are guesses about a display. It is:
//
//     WOULD SAVING THIS VALUE STORE WHAT IS ALREADY STORED?
//
// Mongoose casts the posted "YYYY-MM-DD" with `new Date(...)`, so constructing the same Date and
// comparing instants answers that exactly, and it cannot drift with the server's timezone, the
// browser's, or IST - none of which appear in it. A real date edit still produces a different
// instant and is still reported as changed.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function sameStoredValue(before: unknown, after: unknown): boolean {
  if (before instanceof Date && typeof after === "string" && DATE_ONLY.test(after)) {
    const wouldStore = new Date(after).getTime();
    return !Number.isNaN(wouldStore) && before.getTime() === wouldStore;
  }
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
}

export function changedFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown>,
): string[] {
  return Object.keys(after).filter((key) => !sameStoredValue(before?.[key], after[key]));
}

export async function auditDiff(
  entity: string,
  entityId: unknown,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  actor?: string | null,
  actorType: ActorType = "USER",
) {
  for (const key of changedFields(before, after)) {
    // No maskSensitive here any more — audit() masks on the way in, so this had become the
    // SECOND copy of the same decision. Two masking sites is how one of them stops matching.
    await audit({ entity, entityId, field: key, oldValue: before?.[key], newValue: after[key], actor, actorType });
  }
}

// 2026-08-24: the audit log records WHAT changed, and for one field that must not mean recording the
// value. An Aadhaar number written here in full would survive every retention rule the record itself
// has, sit in a collection nobody redacts, and be copied by anything that reads AuditLog — the audit
// trail becoming the leak is a familiar way for this to go wrong. "Changed from ****1234 to ****5678"
// answers every question an audit row is actually asked: who changed it, when, and that it changed.
//
// Field-name based, like scripts/mirror-prod.mjs REDACT (QA-536), and for the same stated reason:
// adding one is then a decision somebody makes, not a pattern that might quietly stop matching.
// QA-1062 cycle 2 (2026-08-25): tc_password joins it, and the reason is the same sentence one line
// up — the audit trail becoming the leak. A checker proved the route reachable: the Sync Inbox's
// revert door audits BOTH the old and the new tc_password, and api/audit/[entity]/[id] is
// requireUser() plus a scope check that binds only `isScoped` users — so an Operations login read
// both live portal passwords straight out of the trail, with the list route's mask working
// perfectly a metre away. Masking WHO can see the queue does nothing about a value copied into a
// collection nobody redacts.
// A last-4 tail is wrong for a password (it is a hint, not an identifier), so a secret is stamped
// as present-or-absent and nothing more; aadhaar keeps its ****1234 tail because there the tail is
// how a human recognises the right record.
const AUDIT_MASK_FIELDS = new Set(["aadhaar_no"]);
const AUDIT_SECRET_FIELDS = new Set(["tc_password", "aebas_password"]);
function maskSensitive(field: string, value: unknown): unknown {
  if (AUDIT_SECRET_FIELDS.has(field)) {
    const s = String(value ?? "");
    return s ? "(set)" : value; // present-or-absent; absent stays absent, as below
  }
  if (!AUDIT_MASK_FIELDS.has(field)) return value;
  const s = String(value ?? "");
  if (!s) return value; // absent stays absent — "" and null are facts worth keeping as themselves
  return s.length <= 4 ? "****" : "****" + s.slice(-4);
}
