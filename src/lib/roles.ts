// "Center Manager" (qa/gates/center-manager-role.md, Manish 2026-10-21): a centre-based employee
// who does the Operations team's work but only at the centres Admin assigned. Before this, every
// place that meant "the Operations team" spelled the string "Operations" itself (~70 copies across
// 40 files - ARCHITECTURE.md section 3), so a second role with the same rights meant 70 edits and
// the next role would have meant 70 more. They all read THIS one group now.
//
// WHY A NEW FILE (the one exception to edit-in-place): it must be importable by server routes AND
// by "use client" screens. `models/index.ts` pulls mongoose into a client bundle, `authz.ts` pulls
// next/server + auth, `client.ts` is "use client" (a server route cannot import it), and
// `permissions.ts` is mongoose too (its own header says the client half cannot import it).
// No existing module is dependency-free, so this one has NO imports - keep it that way.
//
// What the group does NOT carry: scope. Operations stays unscoped and Center Manager is scoped;
// that difference lives in ONE place, `ALWAYS_SCOPED_ROLES` below, read by `authz.isScoped`.

/** The Operations team: Operations (all centres) and Center Manager (own centres only). */
export const OPS_TEAM = ["Operations", "Center Manager"] as const;

/** Admin plus the Operations team - what the old `["Admin","Operations"]` literals meant. */
export const ADMIN_OPS = ["Admin", ...OPS_TEAM] as const;

/** Roles confined to `location_scope` whatever its length (an empty scope sees nothing). */
export const ALWAYS_SCOPED_ROLES = ["Location", "Trainer", "Center Manager"] as const;

/**
 * Logins whose edits to their OWN centre's fixed details are not applied directly (Umesh, 2026-10-21,
 * qa/gates/center-manager-role.md item 5): the centre's identity fields are refused, and the rest of the
 * centre details, the approved targets and the rooms are parked as a location.edit request for Admin.
 * ONE group read by the three doors that carry that branch (locations/[id], locations/[id]/rooms,
 * locations/[id]/targets) - a Center Manager is exactly as bound as a Location (Principal) login.
 */
export const FIXED_EDIT_PARKING_ROLES = ["Location", "Center Manager"] as const;

export function parksFixedEdits(role: unknown): boolean {
  return (FIXED_EDIT_PARKING_ROLES as readonly string[]).includes(String(role));
}

/** Extra requireApproval options for a parked centre edit. A Center Manager's edit must ALWAYS reach
 *  Admin (the decision is "must park"), so it does not depend on the location.edit rule being switched
 *  on; a Location login keeps the rule-dependent behaviour it has always had. */
export function fixedEditApprovalOpts(role: unknown): { fallbackApproverRole?: string } {
  return role === "Center Manager" ? { fallbackApproverRole: "Admin" } : {};
}

export function isOpsTeam(role: unknown): boolean {
  return (OPS_TEAM as readonly string[]).includes(String(role));
}

export function isAdminOrOps(role: unknown): boolean {
  return role === "Admin" || isOpsTeam(role);
}

/**
 * Who an alert is addressed to. An alert tied to a centre (`location` set) also goes to the Center
 * Managers of that centre whenever it goes to Operations - the inbox (api/notifications) and the
 * mailer (mailer.ts mailUsersByRole) then confine a Center Manager to alerts whose `location` is in
 * their own `location_scope`. An alert tied to NO centre (a trainer applying from the website, a
 * portal lookup) is returned unchanged, so it stays with the roles it named (Operations/Admin).
 */
export function alertRoles(roles: readonly string[], location: unknown): string[] {
  const out = [...roles];
  if (location && out.includes("Operations") && !out.includes("Center Manager")) out.push("Center Manager");
  return out;
}

/** A Center Manager with no centre would be a login that sees nothing (fail closed) - refuse it where
 *  the account is created or edited, with a message an Admin can act on. null = fine. */
export const CENTER_MANAGER_NEEDS_CENTRE = "A Center Manager must be assigned at least one centre. Pick the centre or centres this person manages.";
export function centerManagerScopeError(role: unknown, scope: unknown): string | null {
  if (role !== "Center Manager") return null;
  return Array.isArray(scope) && scope.length > 0 ? null : CENTER_MANAGER_NEEDS_CENTRE;
}
