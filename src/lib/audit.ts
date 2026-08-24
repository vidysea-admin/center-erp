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
  await AuditLog.create({
    entity: opts.entity,
    entity_id: opts.entityId,
    field: opts.field,
    old_value: opts.oldValue ?? null,
    new_value: opts.newValue ?? null,
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
      await audit({ entity, entityId, field: key, oldValue: maskSensitive(key, oldV), newValue: maskSensitive(key, newV), actor, actorType });
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
const AUDIT_MASK_FIELDS = new Set(["aadhaar_no"]);
function maskSensitive(field: string, value: unknown): unknown {
  if (!AUDIT_MASK_FIELDS.has(field)) return value;
  const s = String(value ?? "");
  if (!s) return value; // absent stays absent — "" and null are facts worth keeping as themselves
  return s.length <= 4 ? "****" : "****" + s.slice(-4);
}
