// Permission engine (2026-08-11, CEO): AWS-style group toggles. Each role is a "group"
// whose feature-rights an Admin can toggle; individual users can carry extra grants on top.
// Effective rights = role's toggled set ∪ user.extra_permissions. Admin bypasses everything.
//
// This OVERLAYS the existing role gates rather than replacing them: every route keeps its
// baseline role check, and requirePerm() additionally lets a granted permission open a gate
// the role alone would not. Revoking a default from a role closes the gate for that role.
import { RolePermission, User } from "@/models";
import { HttpError, requireEdit } from "@/lib/authz";
import type { SessionUser } from "@/auth";

// The catalog — every togglable feature-right, grouped for the Admin UI.
export const PERMISSIONS: { key: string; label: string; group: string }[] = [
  { key: "sheet.approve", label: "Approve/apply sheet changes (Sync Inbox + Sheet Watch)", group: "Sheets" },
  { key: "sheet.sources", label: "Configure sync sources", group: "Sheets" },
  { key: "locations.manage", label: "Create/edit locations, contacts, notes", group: "Locations" },
  { key: "trainers.manage", label: "Create/edit trainers & requests", group: "Trainers" },
  { key: "candidates.manage", label: "Create/edit/import candidates", group: "Candidates" },
  { key: "candidates.assign", label: "Assign candidates to batches", group: "Candidates" },
  // 2026-08-24 (Umesh): "koi galti se candidate delete krr diyaa tho delete krne ka option dena hai
  // team ko … esse hi trainer ko bhi delete kr skte hai and batch ko bhi delete krr skte hai but vo
  // bhi respective acess wale persons."
  //
  // All three delete verbs ALREADY EXISTED and already carried their safety refusals; each was shut
  // behind a hard-coded `user.role !== "Admin"`, which is why the team could not see the buttons.
  // Umesh chose THREE separate rights rather than one, so a centre principal can clear a junk
  // candidate row without also being able to erase a trainer or a batch.
  //
  // Deleting is deliberately NOT folded into `.manage`: editing a record and destroying it are
  // different powers, and this product already learned that the expensive way — `assertTrainerDocDeleteInScope`
  // exists precisely because document DELETE had to be narrower than document read/upload.
  { key: "candidates.delete", label: "Delete candidate records (junk rows only — a real person is Dropped)", group: "Candidates" },
  { key: "trainers.delete", label: "Delete trainer records (junk rows only — a real trainer is Dropped)", group: "Trainers" },
  { key: "batches.delete", label: "Delete empty batch shells (a batch with any history is Cancelled)", group: "Batches" },
  // 2026-08-25 (Umesh, feedback-inbox): a batch created by mistake (e.g. for a test) that already
  // has data on it (members, results, logs, etc.) could only be Cancelled, never deleted — and
  // Umesh wanted a real delete for exactly that case, kept separate from the empty-shell right
  // above so it can be granted narrowly. No separate "reset the location's batch-code counter"
  // code is needed: nextBatchCode() (src/lib/rules.ts) already derives the next code by scanning
  // for the lowest free number among live batches, so deleting one frees its number automatically.
  { key: "batches.delete_with_data", label: "Force-delete a batch that carries recorded work (members, results, costs, logs, closure, attendance, invoices) — batches.delete alone only removes empty shells", group: "Batches" },
  { key: "batches.manage", label: "Plan/edit batches & transitions", group: "Batches" },
  { key: "batches.daily_log", label: "Enter daily logs & evidence", group: "Batches" },
  { key: "closure.manage", label: "Assessment, certification & closure", group: "Batches" },
  { key: "attendance.govt", label: "Import & reconcile government portal attendance", group: "Batches" },
  { key: "costs.manage", label: "Enter costs", group: "Finance" },
  { key: "invoices.manage", label: "Manage invoices", group: "Finance" },
  { key: "feedback.links", label: "Generate public registration/feedback links", group: "Public" },
  // 15/08 (Umesh): "bypass all the steps and direct select any status" — for a trainer
  // who already works with us (batch running/complete) and whose papers arrive later.
  // Admin holds it implicitly (role bypass); grant it to a specific person via the
  // per-user Special rights. Every use is confirmed in the UI and audited.
  { key: "pipeline.bypass", label: "Bypass pipeline steps (set any status directly)", group: "Admin" },
  { key: "users.manage", label: "Create/approve users & assign rights", group: "Admin" },
  { key: "defaults.manage", label: "Edit planning defaults & master lists", group: "Admin" },
  // 2026-08-25 (Umesh, feedback-inbox): Admin's course (Program) dropdown had no delete option at
  // all. Unlike the master-lists philosophy elsewhere (job-roles/schemes/cost-categories are
  // deactivate-only, never deleted), Umesh explicitly chose a real delete here: "Delete hamesha
  // allow karo, Admin ki marzi" — no usage check.
  { key: "programs.delete", label: "Delete a course/programme record", group: "Admin" },
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
    // 2026-08-24: all three deletes. Operations already carries every corresponding .manage right,
    // and clearing junk rows out of the pool is their job.
    "candidates.delete", "trainers.delete", "batches.delete",
  ],
  // 2026-08-13 (Umesh + CEO): principal/SPOC = "same admin access limited to their location —
  // trainer, candidate and all; NO attendance (trainer karega); NO batch edit; certificate
  // upload YES (closure.manage carries it); NO accounts (never granted here)".
  Location: [
    "locations.manage", "trainers.manage", "candidates.manage", "candidates.assign",
    "closure.manage", "feedback.links",
    // 2026-08-24: the CANDIDATE delete only. A principal clears a mis-typed row out of their own
    // pool; erasing a trainer or a batch is a wider blast radius than their remit, and the 2026-08-13
    // ruling on this role already drew that line ("NO batch edit"). An Admin can still grant either
    // of the other two to a specific person via the per-user Special rights.
    "candidates.delete",
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

// (getEffectivePermissions — the flat-set predecessor — retired in QA-025 P1; every caller
// moved to getEffectiveLevels below. Deny-wins semantics carried over verbatim.)

// ---- QA-025 P1 (Umesh-approved design, DESIGN-3-level-rights.md): three-level rights ----
// Every entry in the matrix / grants / revokes is either a bare key (= EDIT, today's exact
// meaning — zero migration by construction) or "key:view" / "key:edit". parseLevel is THE
// parser; nothing else reads the suffix.
export type PermLevel = "view" | "edit";
const LEVEL_RANK: Record<PermLevel, number> = { view: 1, edit: 2 };

export function parseLevel(entry: string): { key: string; level: PermLevel } {
  const i = entry.lastIndexOf(":");
  if (i > 0) {
    const suffix = entry.slice(i + 1);
    if (suffix === "view" || suffix === "edit") return { key: entry.slice(0, i), level: suffix };
  }
  return { key: entry, level: "edit" };
}

// Effective level per key: max(role, grants) — a grant only ever UPGRADES (downgrade is what
// revoke is for). Deny wins like R-B: a bare revoke = none; a ":edit" revoke strips edit but
// leaves view standing. Rule 39 stays exactly itself as a cap: can_edit=false ⇒ nothing
// above view. Admin: always edit on everything (bypass, as today).
export async function getEffectiveLevels(user: SessionUser): Promise<Map<string, PermLevel>> {
  const levels = new Map<string, PermLevel>();
  if (user.role === "Admin") {
    for (const p of PERMISSIONS) levels.set(p.key, "edit");
    return levels;
  }
  const bump = (entry: string) => {
    const { key, level } = parseLevel(entry);
    const cur = levels.get(key);
    if (!cur || LEVEL_RANK[level] > LEVEL_RANK[cur]) levels.set(key, level);
  };
  for (const e of await getRolePermissions(user.role)) bump(e);
  const doc = await User.findById(user.id).select("extra_permissions revoked_permissions can_edit").lean<any>();
  for (const e of doc?.extra_permissions ?? []) bump(e);
  for (const e of doc?.revoked_permissions ?? []) {
    const { key } = parseLevel(e);
    if (String(e).endsWith(":edit")) { if (levels.get(key) === "edit") levels.set(key, "view"); }
    else levels.delete(key); // bare (or :view) revoke = the whole right is gone
  }
  if (doc && doc.can_edit === false) {
    for (const [k, l] of levels) if (l === "edit") levels.set(k, "view");
  }
  return levels;
}

// level ≥ view. The historical name kept on purpose — its callers are read-side decisions
// (masking, UI capability checks) and their meaning does not change.
export async function hasPermission(user: SessionUser, perm: string): Promise<boolean> {
  if (user.role === "Admin") return true;
  return (await getEffectiveLevels(user)).has(parseLevel(perm).key);
}

// level ≥ view, throwing — the read-side gate (QA-025 P2: finance GETs sit on this).
export async function requireView(user: SessionUser, perm: string): Promise<void> {
  if (!(await hasPermission(user, perm))) {
    const label = PERMISSIONS.find((p) => p.key === parseLevel(perm).key)?.label ?? perm;
    throw new HttpError(403, `You do not have the "${label}" right. Ask an Admin to grant it.`);
  }
}

// level = EDIT, non-throwing. QA-1459: `GET /api/batches/[id]/members` has to ask "may this user
// edit candidates?" to decide how much of each candidate to put on the wire, and a GET cannot use
// the throwing form for that - refusing the roster is not the answer, sending less of it is. The
// only non-throwing check that existed was `hasPermission`, which is >= VIEW, so a call site
// needing EDIT had to restate requirePerm's rule inline. That is precisely the two-statements-of-
// one-rule drift the QA-617 note below records. requirePerm now DECIDES from this function and
// computes `level` only to word its error, so there is one statement of "edit" and one of "why not".
export async function hasEditLevel(user: SessionUser, perm: string): Promise<boolean> {
  if (user.role === "Admin") return true;
  return (await getEffectiveLevels(user)).get(parseLevel(perm).key) === "edit";
}

// level = EDIT required, throwing. Every existing caller is a write-ish gate, so their meaning is
// unchanged for everyone holding bare keys — a ":view" holder now reads but cannot write.
export async function requirePerm(user: SessionUser, perm: string): Promise<void> {
  if (await hasEditLevel(user, perm)) return;
  const key = parseLevel(perm).key;
  const level = (await getEffectiveLevels(user)).get(key);
  const label = PERMISSIONS.find((p) => p.key === key)?.label ?? perm;
  throw new HttpError(403, level === "view"
    ? `Your "${label}" right is view-only. Ask an Admin for the edit level.`
    : `You do not have the "${label}" right. Ask an Admin to grant it.`);
}

// QA-617 (-194): "may this user share a plan link?" — asked in two places that disagreed in BOTH
// directions. `GET /api/batches/[id]/plan` used `hasPermission` (level >= view) plus its own
// `can_edit !== false`, while `POST /api/public-tokens` uses `requireRole` + `requireEdit` +
// `requirePerm` (level must be EDIT, and requireEdit exempts Admin and Operations). So a view-only
// holder of `feedback.links` was shown the centre's staff list WITH their phone numbers and then
// 403'd on sending, and an Admin with `can_edit: false` — the schema's own default — could send but
// was shown nobody to send to.
//
// This runs the mint gate ITSELF and reports whether it would pass, rather than restating it. Two
// statements of one rule is how they drift, and this pair had already drifted before anyone looked.
export async function canShareLinks(user: SessionUser): Promise<boolean> {
  try {
    if (!["Admin", "Operations", "Location"].includes(String(user.role))) return false;
    requireEdit(user);
    await requirePerm(user, "feedback.links");
    return true;
  } catch { return false; }
}
