// Seed: defaults, master lists, admin user. Idempotent — safe to re-run.
// Run: node --env-file=.env.local scripts/seed.mjs
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const url = process.env.MONGODB_URL;
const dbName = process.env.MONGODB_DB || "center_erp";
if (!url) { console.error("MONGODB_URL missing"); process.exit(1); }

await mongoose.connect(url, { dbName, serverSelectionTimeoutMS: 10000 });
const db = mongoose.connection.db;

// Defaults (§8)
await db.collection("defaults").updateOne(
  { _singleton: "defaults" },
  { $setOnInsert: {
    _singleton: "defaults", batch_size: 30, duration_days: 15, buffer_days: 5,
    completion_deadline_days: 90, mobilisation_lead_days: 7,
    attendance_gap_amber: 5, attendance_gap_red: 10,
    daily_log_edit_window_hours: 48, max_concurrent_batches: 5, roster_threshold_pct: 80,
    enrollment_threshold_pct: 80,
  } },
  { upsert: true },
);

// Master lists
for (const name of ["Trainer Fee", "Trainer Incentive", "TOT Cost", "Travel", "Rent", "Materials", "Assessment Fee", "Other"]) {
  await db.collection("costcategories").updateOne({ name }, { $setOnInsert: { name, active: true } }, { upsert: true });
}
for (const name of ["Got a job", "Family reasons", "Relocated", "Health", "Not interested", "Joined another course", "Other"]) {
  await db.collection("dropreasons").updateOne({ name }, { $setOnInsert: { name, active: true } }, { upsert: true });
}

// Admin user
const email = "admin@vidysea.com";
const existing = await db.collection("users").findOne({ email });
if (!existing) {
  const password_hash = await bcrypt.hash("admin123", 10);
  await db.collection("users").insertOne({
    name: "Admin", email, password_hash, role: "Admin",
    location_scope: [], can_edit: true, active: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  console.log("Admin user created: admin@vidysea.com / admin123  (CHANGE THIS PASSWORD)");
} else {
  console.log("Admin user already exists");
}

console.log("Seed complete on", dbName);
await mongoose.disconnect();
