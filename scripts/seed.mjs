// Seed: defaults, master lists, admin user. Idempotent — safe to re-run.
// Run: node --env-file=.env.local scripts/seed.mjs
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { requireSafeDb } from "./db-guard.mjs";

const url = process.env.MONGODB_URL;
const dbName = requireSafeDb("seed");
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
//
// QA-1825 (CEO, 2026-09-05): the finance rights are the ONE pair the Admin role does not carry for
// free — "visibility keval aur keval Manish ji aur mere paas hogi… chaahe super admin ho". In
// production Umesh grants them per user to the three named people; this seed's admin stands in for
// one of those three, so it carries the same per-user grant rather than the product pretending the
// Admin role implies finance. An Admin WITHOUT the grant is a real and supported state — the roles
// suite creates one on purpose and asserts every money door refuses it.
const FINANCE_GRANTS = ["finance.view", "finance.approve"];
const email = "admin@vidysea.com";
const existing = await db.collection("users").findOne({ email });
if (!existing) {
  const password_hash = await bcrypt.hash("admin123", 10);
  await db.collection("users").insertOne({
    name: "Admin", email, password_hash, role: "Admin",
    location_scope: [], can_edit: true, active: true,
    extra_permissions: FINANCE_GRANTS,
    createdAt: new Date(), updatedAt: new Date(),
  });
  console.log("Admin user created: admin@vidysea.com / admin123  (CHANGE THIS PASSWORD)");
} else {
  // Idempotent top-up: an existing seed database predates the finance keys, and re-seeding is how
  // every isolation copy is built. $addToSet so a hand-edited grant list is never trampled.
  await db.collection("users").updateOne({ email }, { $addToSet: { extra_permissions: { $each: FINANCE_GRANTS } } });
  console.log("Admin user already exists — finance grants topped up");
}

console.log("Seed complete on", dbName);
await mongoose.disconnect();
