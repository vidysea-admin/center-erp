// Registers the CLIENT'S OneDrive workbook as this ERP's only sync source. Idempotent — safe to
// re-run; updates the URL/interval if the source already exists.
// Run: node --env-file=.env.local scripts/setup-watch-source.mjs
//
// 2026-08-12 (Manish) this script registered THREE sheets: "3no sheet ka sync rahega… doosri
// sheet se data aayega to crossverify karega hamesha."
// 2026-08-13 Umesh reversed that — the location master has ONE source of truth, the client's
// OneDrive workbook — and the two Google-workbook watches were deleted from production.
// 2026-08-14 06:35:38 THIS SCRIPT PUT THEM BACK, because nobody edited it: an idempotent upsert
// of a list that still named them. They then polled our own trainer/resume/nomination tabs into
// the review queue for three days.
// 2026-08-17 Umesh again, and this time in code: "bus OneDrive wala sync karna hai, baaki sheets
// nahi — this is a must thing." The list below is the client workbook and nothing else, and
// src/lib/workbook.ts `sourceAllowed()` now refuses the rest at the API and in the scheduler, so
// a future edit to this file cannot re-arm them either.
// See OPERATIONS.md "Sync sources — single-truth policy".
import mongoose from "mongoose";

const CLIENT_WORKBOOK_URL =
  process.env.CLIENT_WORKBOOK_URL || process.env.WATCH_SOURCE_URL ||
  "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE";

// The share id lives in the path; production carries this same workbook with a "?rtime=…&redeem=…"
// tail, and a plain string compare read that as a different sheet (which is how the same workbook
// came to be registered twice in mapped mode, and every client change queued for review twice).
const identity = (u) => String(u ?? "").split("?")[0].trim().replace(/\/+$/, "").toLowerCase();

const SOURCES = [
  {
    name: "Vidysea-RPL (client workbook)",
    mode: "watch",
    url: CLIENT_WORKBOOK_URL,
    // Row identity: one row per Institution × Job role. S.N. renumbers on insert — never the key.
    key_columns: ["Institution Name", "Job role"],
    // -111 (Umesh 18/08): "har 5 minute me ho raha hai, usko 24 hours me ek baar karna hai" — supersedes
    // his own 13/08 "make it 5 minute sync". Once a day is the cadence the client edits at; a re-run
    // of this script must never put it back to 5.
    set: { interval_minutes: 1440, frequency: "Manual only" },
  },
  {
    // The mapped twin of the same workbook: reads the location master and files each changed
    // field into the Sync Inbox for OK-per-change review. Named for the canonical row that
    // OPERATIONS.md points at, so re-running this script UPDATES it instead of minting the
    // second mapped source that caused the doubling.
    name: "Vidysea-RPL (OneDrive)",
    mode: "mapped",
    url: CLIENT_WORKBOOK_URL,
    key_columns: [],
    set: {
      frequency: "Daily",
      sync_time: "07:00", // IST — the scheduler reads Asia/Kolkata since -100
      interval_minutes: 30,
      // tc_password is mapped but masked on every review screen for anyone without
      // locations.manage — see SENSITIVE_SYNC_COLUMNS in the sheet-changes route.
      field_mappings: {
        "TC ID": "external_id",
        "Institution Name": "name",
        "State": "state",
        "SPOC Name": "spoc_name",
        "TC Status": "tc_status",
        "TC Password": "tc_password",
      },
    },
  },
];

await mongoose.connect(process.env.MONGODB_URL, {
  dbName: process.env.MONGODB_DB || "center_erp",
  serverSelectionTimeoutMS: 10000,
});
const db = mongoose.connection.db;

for (const s of SOURCES) {
  const res = await db.collection("syncsources").updateOne(
    { name: s.name },
    {
      $set: { source_url: s.url, mode: s.mode, key_columns: s.key_columns, active: true, ...s.set },
      $setOnInsert: { name: s.name, createdAt: new Date() },
    },
    { upsert: true },
  );
  console.log(`${s.name} (${s.mode}): ${res.upsertedCount ? "created" : "updated"}`);
}

// REPORT, never delete: if anything other than the client workbook is registered, say so loudly
// and let a human remove it through the app API (which cascades snapshots/changes and audits the
// removal). A script that silently deleted rows is how this mess started; a script that silently
// created them is how it came back.
const all = await db.collection("syncsources").find({}).project({ name: 1, source_url: 1, mode: 1, active: 1 }).toArray();
const strays = all.filter((x) => identity(x.source_url) !== identity(CLIENT_WORKBOOK_URL));
if (strays.length) {
  console.log(`
⚠️  ${strays.length} source(s) registered that are NOT the client workbook — the app now refuses to poll them, but they should be removed:`);
  // Truncate: test fixtures register whole workbooks as base64 data: URLs, and a raw dump of one
  // is 40 KB of noise that hides the line that matters.
  for (const x of strays) console.log(`     ${x.name}  [${x.mode}${x.active === false ? ", paused" : ""}]  ${String(x.source_url).slice(0, 90)}${String(x.source_url).length > 90 ? "…" : ""}`);
  console.log("     Remove: DELETE /api/sync-sources/<id> (Admin) — clears its snapshots and tracked changes, and audits it.");
}
const dupes = ["watch", "mapped"].filter((m) => all.filter((x) => x.mode === m && identity(x.source_url) === identity(CLIENT_WORKBOOK_URL)).length > 1);
if (dupes.length) console.log(`
⚠️  the client workbook is registered more than once in ${dupes.join(" and ")} mode — every change will be reviewed twice.`);
console.log(`
${all.length} source(s) total; policy allows 2 (one watch + one mapped, both the client workbook).`);
await mongoose.disconnect();
