// QA-510 (S1) / QA-514 — the one guard every write-heavy script asks before it touches a database.
//
// Eight scripts read `process.env.MONGODB_DB || "center_erp"`. `center_erp` is PRODUCTION. So one
// forgotten `--env-file`, or one shell that had the variable and one that did not, and `npm run
// seed` writes defaults, master lists and an admin user WITH A PASSWORD straight into the live
// database — silently, because a default is not an error. `cleanup-testdata.mjs` was in the same
// set, and that one deletes.
//
// A destructive tool has no business having a default database. It should ask, and it should
// refuse the production name unless somebody says the production name out loud. That is what this
// is, and it lives in ONE file on Umesh's call (2026-08-21) precisely so the next script and the
// next change to the rule cannot leave a copy behind — the failure this repo's ARCHITECTURE
// section 3 exists to name.
//
// Usage:
//     import { requireSafeDb, requireLocalBase } from "./db-guard.mjs";
//     const dbName = requireSafeDb("seed");
//
// CI is unaffected: `.github/workflows/ci.yml` sets MONGODB_DB=center_erp_ci explicitly, which is
// exactly the behaviour this asks for.

const PRODUCTION_DB = "center_erp";
const OVERRIDE = "ALLOW_PRODUCTION_WRITE";
const OVERRIDE_VALUE = "yes-i-mean-production";

function stop(lines) {
  console.error("\n" + lines.join("\n") + "\n");
  process.exit(1);
}

/**
 * Returns the database name this script may write to, or exits.
 * @param {string} scriptName - shown in the message, so the operator knows what refused.
 */
export function requireSafeDb(scriptName) {
  // QA-1528: trimmed once here, same as QA-1520's fix to src/lib/db.ts - an untrimmed value from
  // a hand-edited .env would make `db === PRODUCTION_DB` false on a whitespace slip, so the
  // production refusal below would NOT fire and the (still-untrimmed) name would be returned to
  // the caller as if it were a safe non-production db - a destructive script would then proceed
  // to auto-create and write into a phantom, differently-named database instead of refusing
  // loudly. Not case-folded, for the same reason QA-1520 wasn't: a case slip is a genuinely
  // different (case-sensitive) Mongo database name, and refusing on it is the safer failure mode.
  const db = (process.env.MONGODB_DB ?? "").trim();
  if (!db) {
    stop([
      `${scriptName}: MONGODB_DB is not set, and this script WRITES.`,
      "",
      "It used to fall back to \"center_erp\", which is production. It will not guess any more.",
      "Name the database you mean:",
      "",
      "    MONGODB_DB=center_erp_ci node --env-file=.env.local scripts/" + scriptName + ".mjs",
      "",
      "(a .env file that sets MONGODB_DB works too — the point is that something says it)",
    ]);
  }
  if (db === PRODUCTION_DB && process.env[OVERRIDE] !== OVERRIDE_VALUE) {
    stop([
      `${scriptName}: refusing to run against "${db}" — that is the PRODUCTION database.`,
      "",
      "If you genuinely mean production, say so in full:",
      "",
      `    ${OVERRIDE}=${OVERRIDE_VALUE} MONGODB_DB=${PRODUCTION_DB} node scripts/${scriptName}.mjs`,
      "",
      "Nothing has been read or written.",
    ]);
  }
  return db;
}

/**
 * For scripts that seed THROUGH a running server (seed-sample): the server decides which database
 * the writes land in, so guarding MONGODB_DB alone proves nothing. QA-514.
 * @param {string} scriptName
 * @param {string} base - the BASE_URL this script is about to write through.
 */
export function requireLocalBase(scriptName, base) {
  let host;
  try {
    host = new URL(base).hostname;
  } catch {
    stop([`${scriptName}: BASE_URL "${base}" is not a URL.`]);
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  if (!local && process.env[OVERRIDE] !== OVERRIDE_VALUE) {
    stop([
      `${scriptName}: refusing to seed through ${base}.`,
      "",
      "This script writes through whatever server BASE_URL points at, so that server's database is",
      "the one that changes — naming a test database here would prove nothing.",
      `"${host}" is not local.`,
      "",
      "If you genuinely mean it:",
      "",
      `    ${OVERRIDE}=${OVERRIDE_VALUE} BASE_URL=${base} node scripts/${scriptName}.mjs`,
      "",
      "Nothing has been sent.",
    ]);
  }
  return base;
}
