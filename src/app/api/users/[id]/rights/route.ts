import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { requireView, getEffectiveLevels, PERMISSIONS, NO_ADMIN_BYPASS } from "@/lib/permissions";
import { User } from "@/models";

// QA-1897 (Umesh, 2026-09-06): *"admin waale me bas role dikh raha hai… role wise, jaise admin role
// hai, admin role mein kaun se account hain, account mein kaun se access hain, woh dikhna chahiye…
// taaki admin, Admin portal se baaki users ko sab ko access is tareeke se provide kar sake."*
//
// The Admin screen could say what ROLE someone has and could toggle a role's rights in the matrix,
// but it could never answer the question an Admin actually asks about a PERSON: what can this
// account do, right now, counting the role's stored rights, their own extra grants and their own
// revocations. That answer existed only inside `getEffectiveLevels`, on the server, per request.
//
// THIS ROUTE DOES NOT RE-DERIVE IT. It calls the same function every gate calls, so the screen and
// the door can never disagree — the alternative was recomputing "role ∪ extra − revoked" in the
// browser, which is a second copy of the one rule this module spent its whole life defending
// (ARCHITECTURE.md §3). A second copy would also have been WRONG on day one: it could not know
// about NO_ADMIN_BYPASS, so it would have shown every Admin holding finance.view.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const me = await requireUser();
  // Reading who-can-do-what is part of managing users; it is not a money door and carries no
  // money, so `users.manage` at view level is the right gate — the same one the user list uses.
  await requireView(me, "users.manage");

  const { id } = await ctx.params;
  const target = await User.findById(id).select("name email role active dropped extra_permissions revoked_permissions").lean<any>();
  if (!target) throw new HttpError(404, "User not found");

  // The real thing, from the real function, for THIS person.
  const levels = await getEffectiveLevels({
    id: String(target._id),
    role: target.role,
    can_edit: true,
  } as any);

  const rights = PERMISSIONS.map((p) => ({
    key: p.key,
    label: p.label,
    group: p.group,
    level: levels.get(p.key) ?? "none",
    // WHY they have it, which is the half that makes the screen actionable: an Admin looking at a
    // right needs to know whether to change the ROLE's matrix or this person's own grants.
    source: (target.revoked_permissions ?? []).map(String).some((k: string) => k === p.key || k.startsWith(`${p.key}:`))
      ? "revoked for this person"
      : (target.extra_permissions ?? []).map(String).some((k: string) => k === p.key || k.startsWith(`${p.key}:`))
        ? "granted to this person"
        : levels.get(p.key)
          ? (NO_ADMIN_BYPASS.has(p.key) ? "from the role's matrix" : (target.role === "Admin" ? "the Admin role" : "from the role's matrix"))
          : "—",
    // The two keys the Admin short-circuit does not open. Saying so on the screen is the point:
    // an Admin who cannot find money in their own rights should be told why, not left guessing.
    no_admin_bypass: NO_ADMIN_BYPASS.has(p.key),
  }));

  return NextResponse.json({
    user: { _id: target._id, name: target.name, email: target.email, role: target.role, active: target.active, dropped: target.dropped },
    rights,
    held: rights.filter((r) => r.level && String(r.level) !== "none").length,
    total: rights.length,
  });
});
