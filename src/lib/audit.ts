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
export async function auditDiff(
  entity: string,
  entityId: unknown,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  actor?: string | null,
  actorType: ActorType = "USER",
) {
  for (const key of Object.keys(after)) {
    const oldV = before?.[key];
    const newV = after[key];
    if (JSON.stringify(oldV ?? null) !== JSON.stringify(newV ?? null)) {
      // No maskSensitive here any more — audit() masks on the way in, so this had become the
      // SECOND copy of the same decision. Two masking sites is how one of them stops matching.
      await audit({ entity, entityId, field: key, oldValue: oldV, newValue: newV, actor, actorType });
    }
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
