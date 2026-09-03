// The archive/restore logic for a single candidate, extracted so the single-row DELETE door
// (src/app/api/candidates/[id]/route.ts) and the bulk doors (bulk-archive, bulk-unarchive,
// [id]/unarchive) call the SAME code rather than growing a second copy that drifts — the
// "second copy did not get the fix" failure ARCHITECTURE.md section 3 exists to warn about.
import { BatchMember } from "@/models";
import { HttpError } from "@/lib/authz";
import { audit } from "@/lib/audit";

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
