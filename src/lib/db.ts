import mongoose from "mongoose";

const MONGODB_URL = process.env.MONGODB_URL!;
// QA-1520: trimmed ONCE here so every use (this comparison below, and the dbName mongoose.connect
// is given further down) agrees - a hand-edited .env with a trailing space/newline on MONGODB_DB
// used to fail the production exemption's exact `===` match and refuse the real production
// connection outright. Deliberately NOT case-folded: a differently-cased name is a genuinely
// different MongoDB database (names are case-sensitive), and Mongo auto-creates a database on
// first write - silently exempting a case slip would risk connecting to (and creating) a wrong,
// empty database instead of the real one. Refusing on a case slip is the correct failure mode;
// only whitespace has no such downside.
const MONGODB_DB = (process.env.MONGODB_DB || "center_erp").trim();
const PRODUCTION_DB = "center_erp";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

declare global {
  // eslint-disable-next-line no-var
  var _mongoose: { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null } | undefined;
}

const cached = global._mongoose ?? (global._mongoose = { conn: null, promise: null });

// QA-851: pulls every host out of a MongoDB connection string. Handles the plain
// mongodb://[user:pass@]host[:port][,host2[:port2]...][/db][?opts] shape - what this project's own
// .env.local and OPERATIONS.md:62 both use, always a single host, never SRV - including a
// comma-separated replica-set host list, since `new URL()` throws "Invalid URL" on those outright
// (verified: `new URL("mongodb://h1:27017,h2:27017/db")` rejects it) rather than reading only the
// first host. mongodb+srv:// (one DNS-resolved name, no explicit port) is accepted by this same
// parser for completeness even though nothing in this codebase currently uses that shape.
export function extractMongoHosts(url: string): string[] {
  const afterScheme = url.match(/^mongodb(?:\+srv)?:\/\/(.*)$/i);
  if (!afterScheme) {
    throw new Error(`dbConnect: MONGODB_URL does not look like a mongodb:// or mongodb+srv:// URL: "${url}"`);
  }
  let authority = afterScheme[1];
  const pathOrQueryIdx = authority.search(/[/?]/);
  if (pathOrQueryIdx !== -1) authority = authority.slice(0, pathOrQueryIdx);
  const atIdx = authority.lastIndexOf("@"); // strip user:pass@ - a host can never contain '@'
  if (atIdx !== -1) authority = authority.slice(atIdx + 1);
  return authority.split(",").map((entry) => {
    entry = entry.trim();
    if (entry.startsWith("[")) {
      // IPv6 literal, e.g. [::1]:27017
      return entry.slice(1, entry.indexOf("]")).toLowerCase();
    }
    const colonIdx = entry.lastIndexOf(":");
    return (colonIdx === -1 ? entry : entry.slice(0, colonIdx)).toLowerCase();
  });
}

// QA-851 (2026-08-24/27): the DB-NAME guard (CLAUDE.md's "MONGODB_DB=center_erp_ci, never
// center_erp", enforced for standalone scripts by scripts/db-guard.mjs and for the wall by
// scripts/run-e2e.mjs) checks WHAT a run writes to. It says nothing about WHERE it connects. A
// server started with a test-shaped MONGODB_DB but this project's own .env.local default
// (MONGODB_URL=mongodb://13.202.206.101:27017, the shared PRODUCTION Mongo host per
// OPERATIONS.md:62) still connects to the LIVE production host, just under a differently-named
// database - QA-545 already documents that host answering without authentication. No production
// DATA was touched the one time this happened (2026-08-24: MONGODB_DB=center_erp_verify), but
// nothing structurally stopped the next accident from being one string closer to "center_erp".
// This is the host-side twin, at the one place every path into this database actually runs
// through: dbConnect() itself, so it protects `next dev`/`next start` and any script that imports
// dbConnect directly, not only wall runs that go through run-e2e.mjs's own (separate, orchestrator
// -level) check above. MONGODB_DB === "center_erp" is deliberately EXEMPT - that is the one case
// where the real production host is the correct, intended target, and this guard must never block
// the actual production deploy path.
export function assertSafeConnectionTarget(url: string, dbName: string) {
  if (dbName === PRODUCTION_DB) return; // real production path - untouched by this guard
  const hosts = extractMongoHosts(url);
  const offending = hosts.filter((h) => !LOOPBACK_HOSTS.has(h));
  if (offending.length > 0) {
    throw new Error(
      `dbConnect: refusing to connect - MONGODB_DB="${dbName}" is not the production database, but ` +
        `MONGODB_URL points at non-loopback host(s) [${offending.join(", ")}]. A test/verification ` +
        `run may only reach a local Mongo (127.0.0.1, localhost, or ::1). Fix MONGODB_URL to a ` +
        `loopback address, or if this genuinely is the production database, set MONGODB_DB=${PRODUCTION_DB}.`
    );
  }
}

export async function dbConnect() {
  assertSafeConnectionTarget(MONGODB_URL, MONGODB_DB);
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    // QA-899: a rejected connect promise used to stay cached forever - the NEXT request awaited
    // the SAME rejected promise instead of trying a fresh connect, so one transient Mongo blip at
    // startup permanently killed every DB-backed request until the process was restarted by hand,
    // while /api/public/version (which never touches Mongo) kept reporting 200. Clearing the cache
    // on rejection lets the next call retry instead of replaying the same failure forever.
    cached.promise = mongoose.connect(MONGODB_URL, {
      dbName: MONGODB_DB,
      serverSelectionTimeoutMS: 10000,
    }).catch((err) => {
      cached.promise = null;
      throw err;
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
