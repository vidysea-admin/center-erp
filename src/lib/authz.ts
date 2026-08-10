import { auth, SessionUser } from "@/auth";
import { NextResponse } from "next/server";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  const user = session?.user as unknown as SessionUser | undefined;
  if (!user?.id) throw new HttpError(401, "Unauthorized");
  return user;
}

// Rule 40: role gates
export function requireRole(user: SessionUser, ...roles: SessionUser["role"][]) {
  if (!roles.includes(user.role)) throw new HttpError(403, "Forbidden for role " + user.role);
}

// Rule 39: can_edit=false → view/acknowledge only. plan1.md resolution #3: Location
// read-only users are VIEW ONLY (no acknowledge).
export function requireEdit(user: SessionUser) {
  if (user.role === "Admin" || user.role === "Operations") return;
  if (!user.can_edit) throw new HttpError(403, "Read-only access");
}

// Rule 38: Location-role users see only rows in location_scope — enforced per query.
// Enrollment users are scoped the same way when a location_scope is set; an empty
// scope means a central enrollment operator working across all locations.
function isScoped(user: SessionUser): boolean {
  if (user.role === "Location") return true;
  return user.role === "Enrollment" && (user.location_scope?.length ?? 0) > 0;
}

export function locationFilter(user: SessionUser, field = "location"): Record<string, unknown> {
  if (isScoped(user)) return { [field]: { $in: user.location_scope } };
  return {};
}

export function assertLocationInScope(user: SessionUser, locationId: string) {
  if (isScoped(user) && !user.location_scope.map(String).includes(String(locationId))) {
    throw new HttpError(403, "Location out of scope");
  }
}

// Wrap an API handler: converts HttpError/other errors into JSON responses.
export function apiHandler<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e: unknown) {
      if (e instanceof HttpError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      const msg = e instanceof Error ? e.message : "Internal error";
      // Mongo duplicate key → readable 409
      if (typeof msg === "string" && msg.includes("E11000")) {
        return NextResponse.json({ error: "Duplicate value violates a uniqueness rule: " + msg }, { status: 409 });
      }
      console.error(e);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  };
}
