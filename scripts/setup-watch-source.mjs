// Registers the client's live OneDrive workbook (Vidysea-RPL.xlsx) as a watch-mode sync
// source (2026-08-11 meeting). Idempotent — safe to re-run; updates the URL/interval if the
// source already exists. Run: node --env-file=.env.local scripts/setup-watch-source.mjs
import mongoose from "mongoose";

const SHARE_URL =
  process.env.WATCH_SOURCE_URL ||
  "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE";

await mongoose.connect(process.env.MONGODB_URL, {
  dbName: process.env.MONGODB_DB || "center_erp",
  serverSelectionTimeoutMS: 10000,
});
const db = mongoose.connection.db;

const res = await db.collection("syncsources").updateOne(
  { name: "Vidysea-RPL (client workbook)" },
  {
    $set: {
      source_url: SHARE_URL,
      mode: "watch",
      interval_minutes: 30,
      // Row identity: the sheet is one row per Institution × Job role. S.N. renumbers when
      // rows are inserted, so it must never be the key.
      key_columns: ["Institution Name", "Job role"],
      frequency: "Manual only", // watch mode ignores the daily schedule; poller uses interval_minutes
    },
    $setOnInsert: { name: "Vidysea-RPL (client workbook)", field_mappings: {}, createdAt: new Date() },
  },
  { upsert: true },
);
console.log(res.upsertedCount ? "Watch source created." : "Watch source updated.");
await mongoose.disconnect();
