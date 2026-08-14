// Permission engine (2026-08-11, CEO): AWS-style group toggles. Each role is a "group"
// whose feature-rights an Admin can toggle; individual users can carry extra grants on top.
// Effective rights = role's toggled set ∪ user.extra_permissions. Admin bypasses everything.
//
// This OVERLAYS the existing role gates rather than replacing them: every route keeps its
// baseline role check, and requirePerm() additionally lets a granted permission open a gate
// the role alone would not. Revoking a default from a role closes the gate for that role.
import { RolePermission, User } from "@/models";
import { HttpError } from "@/lib/authz";
import type { SessionUser } from "@/auth";

// The catalog — every togglable feature-right, grouped for the Admin UI.
export const PERMISSIONS: { key: string; label: string; group: string }[] = [
  { key: "sheet.approve", label: "Approve/apply sheet changes (Sync Inbox + Sheet Watch)", group: "Sheets" },
  { key: "sheet.sources", label: "Configure sync sources", group: "Sheets" },
  { key: "locations.manage", label: "Create/edit locations, contacts, notes", group: "Locations" },
  { key: "trainers.manage", label: "Create/edit trainers & requests", group: "Trainers" },
  { key: "candidates.manage", label: "Create/edit/import candidates", group: "Candidates" },
  { key: "candidates.assign", label: "Assign candidates to batches", group: "Candidates" },
  { key: "batches.manage", label: "Plan/edit batches & transitions", group: "Batches" },
  { key: "batches.daily_log", label: "Enter daily logs & evidence", group: "Batches" },
  { key: "closure.manage", label: "Assessment, certification & closure", group: "Batches" },
  { key: "attendance.govt", label: "Import & reconcile government portal attendance", group: "Batches" },
  { key: "costs.manage", label: "Enter costs", group: "Finance" },
  { key: "invoices.manage", label: "Manage invoices", group: "Finance" },
  { key: "feedback.links", label: "Generate public registration/feedback links", group: "Public" },
  { key: "users.manage", label: "Create/approve users & assign rights", group: "Admin" },
  { key: "defaults.manage", label: "Edit planning defaults & master lists", group: "Admin" },
  { key: "approvals.decide", label: "Decide approval requests", group: "Admin" },
];

// What each role carries until an Admin toggles otherwise — mirrors today's behaviour, so
// seeding these changes nothing on day one.
export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  Admin: PERMISSIONS.map((p) => p.key),
  // QA-083/084/037 (checker round 5): Operations lost the sheet machinery (CEO: "remove
  // sheet sync, all of these things" — the nav went in R-E, the API rights go now) and
  // approvals.decide (the queue handed the same ledger figures back that R-E shut away;
  // their own submissions live under ?mine=1, which needs no right).
  // NOTE (QA-036 pattern): this default changes nothing on live until the matrix PUT runs.
  Operations: [
    "locations.manage", "trainers.manage",
    "candidates.manage", "candidates.assign", "batches.manage", "batches.daily_log",
    "closure.manage", "attendance.govt", "costs.manage", "invoices.manage", "feedback.links",
  ],
  // 2026-08-13 (Umesh + CEO): principal/SPOC = "same admin access limited to their location —
  // trainer, candidate and all; NO attendance (trainer karega); NO batch edit; certificate
  // upload YES (closure.manage carries it); NO accounts (never granted here)".
  Location: [
    "locations.manage", "trainers.manage", "candidates.manage", "candidates.assign",
    "closure.manage", "feedback.links",
  ],
  // QA-036 (checker, vs the role table): Enrollment's brief is candidate registration and
  // the enrollment worklist — daily attendance is the SPOC/Trainer's job, removed 14/08.
  Enrollment: ["candidates.manage", "candidates.assign"],
  Trainer: ["batches.daily_log"],
};

// Role toggles are read per request; a tiny TTL cache keeps that cheap without letting a
// toggle take more than a few seconds to bite.
let cache: { at: number; byRole: Map<string, Set<string>> } | null = null;

export async function getRolePermissions(role: string): Promise<Set<string>> {
  if (!cache || Date.now() - cache.at > 5_000) {
    const docs = await RolePermission.find({}).lean<any[]>();
    const byRole = new Map<string, Set<string>>();
    for (const d of docs) byRole.set(d.role, new Set(d.permissions ?? []));
    cache = { at: Date.now(), byRole };
  }
  return cache.byRole.get(role) ?? new Set(DEFAULT_ROLE_PERMISSIONS[role] ?? []);
}

export function invalidatePermissionCache() { cache = null; }

export async function getEffectivePermissions(user: SessionUser): Promise<Set<string>> {
  const set = new Set(await getRolePermissions(user.role));
  // extra grants live on the user document, not the JWT — a grant works without re-login
  const doc = await User.findById(user.id).select("extra_permissions revoked_permissions").lean<any>();
  for (const p of doc?.extra_permissions ?? []) set.add(p);
  // CEO 14/08: per-user REMOVAL of a right. Deny wins over the role set and extra grants
  // alike — otherwise a revoke could be undone by the very grant list the same screen edits.
  for (const p of doc?.revoked_permissions ?? []) set.delete(p);
  return set;
}

export async function hasPermission(user: SessionUser, perm: string): Promise<boolean> {
  if (user.role === "Admin") return true;
  return (await getEffectivePermissions(user)).has(perm);
}

export async function requirePerm(user: SessionUser, perm: string): Promise<void> {
  if (!(await hasPermission(user, perm))) {
    const label = PERMISSIONS.find((p) => p.key === perm)?.label ?? perm;
    throw new HttpError(403, `You do not have the "${label}" right. Ask an Admin to grant it.`);
  }
}
