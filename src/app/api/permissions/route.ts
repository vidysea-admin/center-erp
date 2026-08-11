import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { requirePerm, PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, invalidatePermissionCache } from "@/lib/permissions";
import { RolePermission, USER_ROLE } from "@/models";
import { audit } from "@/lib/audit";

// Permission matrix (2026-08-11, CEO — AWS-style group toggles).
// GET → catalog + each role's current toggled set (seeded from defaults on first read).
// PUT { role, permissions: [] } → replace a role's set. Admin's set is not editable —
// Admin bypasses checks anyway, and a lockout-by-toggle must be impossible.

export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "users.manage");
  const stored = await RolePermission.find({}).lean<any[]>();
  const byRole = new Map(stored.map((d) => [d.role, d.permissions ?? []]));
  const roles = USER_ROLE.map((role) => ({
    role,
    permissions: byRole.get(role) ?? DEFAULT_ROLE_PERMISSIONS[role] ?? [],
    is_default: !byRole.has(role),
  }));
  return NextResponse.json({ catalog: PERMISSIONS, roles });
});

export const PUT = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // Security review 2026-08-11: editing the matrix is Admin-only, full stop — a granted
  // users.manage holder could otherwise inflate their OWN role's rights.
  if (user.role !== "Admin") throw new HttpError(403, "Only an Admin may change role permissions.");
  const body = await req.json();
  const role = String(body.role ?? "");
  if (!USER_ROLE.includes(role as any)) throw new HttpError(400, "Unknown role");
  if (role === "Admin") throw new HttpError(400, "Admin rights are fixed — Admin bypasses all checks.");
  const valid = new Set(PERMISSIONS.map((p) => p.key));
  const permissions = (Array.isArray(body.permissions) ? body.permissions : []).filter((p: string) => valid.has(p));
  const doc = await RolePermission.findOneAndUpdate(
    { role },
    { $set: { permissions } },
    { upsert: true, new: true },
  );
  invalidatePermissionCache();
  await audit({ entity: "RolePermission", entityId: doc._id, field: role, newValue: permissions, actor: user.id });
  return NextResponse.json({ item: doc });
});
