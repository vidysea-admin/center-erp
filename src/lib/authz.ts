import { auth, SessionUser } from "@/auth";
import { NextResponse } from "next/server";
import { plain } from "@/lib/user-copy";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// 2026-08-12 audit (auth S1-4): role, location_scope, can_edit, deactivation and rejection were
// frozen into the JWT at sign-in and the session lasts 30 days, so none of them reached a live
// session — an Admin could demote, rescope, deactivate or reject an account and that person kept
// their old powers until the token expired. The meeting's promise was "toggles bite within ~5s,
// no re-login", which was true of the permission matrix but not of the identity behind it.
//
// The token still says who you are; the database says what you may do. Re-read that here, where
// every API authorisation decision is made, behind the same short TTL the permission cache uses.
// Deliberately NOT in the jwt/session callback: those also run on the Edge runtime, where
// Mongoose cannot connect.
const IDENTITY_TTL_MS = 5_000;
const identityCache = new Map<string, { at: number; user: SessionUser | null }>();

export function invalidateIdentity(userId?: string) {
  if (userId) identityCache.delete(String(userId));
  else identityCache.clear();
}

export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  const user = session?.user as unknown as SessionUser | undefined;
  if (!user?.id) throw new HttpError(401, "Unauthorized");

  const hit = identityCache.get(user.id);
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) {
    if (!hit.user) throw new HttpError(401, "This account is no longer active. Please sign in again.");
    return hit.user;
  }

  // Imported lazily so this module stays usable from contexts that never touch the database.
  const { dbConnect } = await import("@/lib/db");
  const { User } = await import("@/models");
  await dbConnect();
  const fresh = await User.findById(user.id).select("name email role location_scope can_edit active approval_status").lean<any>();

  if (!fresh || !fresh.active || fresh.approval_status === "Rejected" || fresh.approval_status === "Pending") {
    identityCache.set(user.id, { at: Date.now(), user: null });
    throw new HttpError(401, "This account is no longer active. Please sign in again.");
  }

  const current: SessionUser = {
    id: String(fresh._id),
    name: fresh.name,
    email: fresh.email,
    role: fresh.role,
    location_scope: (fresh.location_scope || []).map(String),
    can_edit: !!fresh.can_edit,
  };
  identityCache.set(user.id, { at: Date.now(), user: current });
  return current;
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
// Trainer users (2026-08-11 self-signup) are ALWAYS scoped: Admin sets their
// location_scope at approval; until then an empty scope means they see nothing scoped.
export function isScoped(user: SessionUser): boolean {
  if (user.role === "Location" || user.role === "Trainer") return true;
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
        // -111: every error a user can read passes through plain() — the ledger codes ("Rule 45",
        // "DEC-6") stay in code and audit, never on a screen. Chokepoint, so a message written
        // tomorrow with a code in it is still clean at the door.
        return NextResponse.json({ error: plain(e.message) }, { status: e.status });
      }
      const msg = e instanceof Error ? e.message : "Internal error";
      // Mongo duplicate key → readable 409 naming the field, without leaking the raw driver text.
      if (typeof msg === "string" && msg.includes("E11000")) {
        const field = msg.match(/index: (\w+)_/)?.[1] ?? msg.match(/dup key: \{ (\w+):/)?.[1];
        return NextResponse.json(
          { error: field ? `That ${field.replace(/_/g, " ")} is already in use.` : "This record already exists." },
          { status: 409 },
        );
      }
      // QA-244 (checker) — the same argument as ValidationError below, for the id itself. A route that
      // is handed "<objectId>:0" (a grid's composite row key), a truncated paste or a stray path
      // segment used to hit Mongoose, come back as a CastError, and be reported as "Something went
      // wrong on our side. Please try again." Nothing had gone wrong on our side and retrying could
      // never help. This sits in apiHandler rather than in crud.ts alone because half the detail
      // routes here are hand-written (batches, closure, results) and a guard only the CRUD routes
      // inherit is a guard with holes — which is exactly what the wall caught on the first cut.
      // The submitted value is NOT echoed: that is what made the original leak dangerous.
      if (e instanceof Error && e.name === "CastError" && (e as unknown as { kind?: string }).kind === "ObjectId") {
        return NextResponse.json({ error: "Not found — that is not a valid id." }, { status: 404 });
      }
      // A ValidationError is the CALLER's mistake, not ours, so it must not be masked as a 500.
      // The S2-15 masking below swept it up with genuine server faults, and the result actively
      // misled: sending an out-of-enum operational_status answered "Something went wrong on our
      // side. Please try again." — nothing had gone wrong on our side, and retrying could never
      // help. Found 2026-08-12 by the RPL blindspot probe, which hit it with a wrong enum value.
      //
      // What made the original leak dangerous was the ECHOED VALUE and the full internal path
      // ("Cast to ObjectId failed for value ... at path ..."), not the field name — field names
      // are already public, since the caller just sent them. So: name the field and, for an enum,
      // the permitted values; never repeat what was submitted.
      if (e instanceof Error && e.name === "ValidationError") {
        const errs = (e as unknown as { errors?: Record<string, { kind?: string; properties?: { enumValues?: string[]; message?: string } }> }).errors ?? {};
        const parts = Object.entries(errs).slice(0, 4).map(([path, err]) => {
          const allowed = err?.properties?.enumValues;
          if (allowed?.length) return `${path} must be one of: ${allowed.join(", ")}`;
          if (err?.kind === "required") return `${path} is required`;
          // QA-1505: a schema-authored message, when the schema wrote one. `properties.message` is
          // where Mongoose puts a CUSTOM validator's own text — ours, written in models/index.ts,
          // never anything the caller submitted (the enum and required branches above still win, so
          // no existing refusal changes wording). Without this, the one schema rule that has a real
          // explanation to give — two contacts sharing an id, which makes a plan link unable to say
          // whose it is — arrived at the screen as "contacts is not valid", and a refusal that does
          // not say what to do is the defect this file already documents twice.
          if (err?.properties?.message) return err.properties.message;
          return `${path} is not valid`;
        });
        return NextResponse.json(
          { error: parts.length ? parts.join("; ") : "Some of the submitted values are not valid." },
          { status: 400 },
        );
      }

      // 2026-08-12 audit (auth S2-15): the raw exception text used to go straight to the client.
      // A connection failure prints the database host and port, and a cast error reveals the
      // schema — none of which a browser needs, and all of which help someone map the system. The
      // detail stays in the server log where it is useful; the client gets a stable, unhelpful-to-
      // an-attacker message. HttpError above is deliberate and human-written, so it still passes.
      console.error(e);
      return NextResponse.json({ error: "Something went wrong on our side. Please try again." }, { status: 500 });
    }
  };
}
