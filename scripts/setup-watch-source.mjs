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
        interval_minutes: 30,
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
await mongoose.disconnect();
