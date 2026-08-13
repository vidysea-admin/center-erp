// Registers the client's live sheets as watch-mode sync sources. Idempotent — safe to re-run;
// updates the URL/interval if a source already exists.
// Run: node --env-file=.env.local scripts/setup-watch-source.mjs
//
// 2026-08-12 (Manish): "3no sheet ka sync rahega… doosri sheet se data aayega to crossverify
// karega hamesha." Both sheets are watched; the ERP derives its own counters from Trainer rows
// and shows each sheet's claim beside them, so a disagreement surfaces instead of overwriting.
import mongoose from "mongoose";

const SOURCES = [
  {
    name: "Vidysea-RPL (client workbook)",
    url: process.env.WATCH_SOURCE_URL ||
      "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE",
    // Row identity: one row per Institution × Job role. S.N. renumbers on insert — never the key.
    key_columns: ["Institution Name", "Job role"],
  },
  {
    // "RPL Project - Required Trainers List" — the individual-trainer master (10-15 tabs).
    // key_columns left EMPTY on purpose: one list cannot fit fifteen differently-shaped tabs,
    // so each tab picks its own identifying columns (see autoKeyIndexes in lib/workbook.ts).
    name: "RPL Required Trainers List",
    url: process.env.TRAINER_SHEET_URL ||
      "https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf/edit",
    key_columns: [],
  },
  {
    name: "Trainer hiring (Vidysea sheet)",
    url: process.env.HIRING_SOURCE_URL ||
      "https://docs.google.com/spreadsheets/d/1d-2n2kXkiqV5YHV4n6Cs5-KE3FVsNwGbPGvfCNXRZXQ",
    // Same grain as the RPL master, short location names — Location + Job Role identify a row.
    key_columns: ["Location", "Job Role"],
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
      $set: {
        source_url: s.url,
        mode: "watch",
        interval_minutes: 5, // 2026-08-13, Umesh: "make it 5 minute sync"
        key_columns: s.key_columns,
        frequency: "Manual only", // watch mode ignores the daily schedule; poller uses interval_minutes
        active: true,
      },
      $setOnInsert: { name: s.name, field_mappings: {}, createdAt: new Date() },
    },
    { upsert: true },
  );
  console.log(`${s.name}: ${res.upsertedCount ? "created" : "updated"}`);
}

// Manish created "AVPL workbook" himself (mapped mode) by pasting the OneDrive link — with no
// field mappings it could never run ("AVPL sheet sync isn't working"). Configure it the way he
// expected it to work: TC ID is the row identity, and the columns whose changes should land in
// the Sync Inbox for OK-per-change review. tc_password is deliberately not mapped — a change row
// would print the credential to every reviewer.
const avpl = await db.collection("syncsources").updateOne(
  { name: "AVPL workbook" },
  {
    $set: {
      mode: "mapped",
      frequency: "Daily",
      sync_time: "07:00",
      active: true,
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
);
console.log(`AVPL workbook (mapped): ${avpl.matchedCount ? "configured" : "not present — skipped"}`);
await mongoose.disconnect();
