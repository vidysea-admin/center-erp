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
      await audit({ entity, entityId, field: key, oldValue: oldV, newValue: newV, actor, actorType });
    }
  }
}
