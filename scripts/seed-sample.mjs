// Sample dataset seeded via the live API (so every rule + audit applies), modeled on the UI mockups.
// Run: node --env-file=.env.local scripts/seed-sample.mjs   (server must be running)
// Idempotent: aborts if JPR03 already exists.
import mongoose from "mongoose";

const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
let cookie = "";

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error}`);
  return data;
}

// login
const csrfRes = await fetch(BASE + "/api/auth/csrf");
const { csrfToken } = await csrfRes.json();
const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
const loginRes = await fetch(BASE + "/api/auth/callback/credentials", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
  body: new URLSearchParams({ csrfToken, email: "admin@vidysea.com", password: process.env.ADMIN_PASSWORD || "admin123" }),
  redirect: "manual",
});
const session = (loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get("set-cookie")]).flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
if (!session) { console.error("Login failed"); process.exit(1); }
cookie = [csrfCookie, session].join("; ");

const existing = await req("GET", "/api/locations?q=JPR03");
if (existing.items.length) { console.log("Sample data already seeded (JPR03 exists). Nothing to do."); process.exit(0); }

const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };

// ---- Programs (mockup: Settings → Programs & Courses) ----
const programDefs = [
  ["MATH-FND", "Mathematics Foundation", "Mathematics"],
  ["PHYS-FND", "Physics Foundation", "Physics"],
  ["CHEM-FND", "Chemistry Foundation", "Chemistry"],
  ["BIO-FND", "Biology Foundation", "Biology"],
  ["REAS-FND", "Reasoning Foundation", "Reasoning"],
];
const programs = {};
for (const [code, name, skill] of programDefs) {
  programs[code] = (await req("POST", "/api/programs", { code, name, trainer_skill: skill, duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90 })).item;
}

// ---- Locations (mockup: Jaipur 03, Kota 02, …) ----
const locationDefs = [
  ["JPR03", "Jaipur 03", "Jaipur", "Neha Sharma", "9876500001", "Dr. R. K. Gupta"],
  ["KOT02", "Kota 02", "Kota", "Vikram Singh", "9876500002", "Mrs. S. Agarwal"],
  ["IND01", "Indore 01", "Indore", "Amit Verma", "9876500003", "Mr. P. Malviya"],
  ["JOD02", "Jodhpur 02", "Jodhpur", "Pooja Mehta", "9876500004", "Dr. A. Rathore"],
  ["UDA01", "Udaipur 01", "Udaipur", "Rohit Joshi", "9876500005", "Mr. K. Menaria"],
  ["AJM01", "Ajmer 01", "Ajmer", "Sanjay Rawat", "9876500006", "Mrs. N. Chauhan"],
  ["BHI01", "Bhilwara 01", "Bhilwara", "Mohit Jain", "9876500007", "Mr. D. Toshniwal"],
  ["ALW01", "Alwar 01", "Alwar", "Ritika Yadav", "9876500008", "Dr. M. Saini"],
];
const locations = {};
for (const [code, name, city, spoc, phone, principal] of locationDefs) {
  const loc = (await req("POST", "/api/locations", {
    code, name, city, state: city === "Indore" ? "Madhya Pradesh" : "Rajasthan",
    external_id: "SDP-" + code, approval_status: "Approved",
    spoc_name: spoc, spoc_phone: phone, principal_name: principal, principal_phone: phone.replace("98765", "98764"),
  })).item;
  await req("PATCH", `/api/locations/${loc._id}`, { operational_status: "Active", status_reason: "Operations started" });
  locations[code] = loc;
  for (const [rn, rt] of [["Classroom 1", "Classroom"], ["Classroom 2", "Classroom"], ["Lab 1", "Lab"]]) {
    await req("POST", `/api/locations/${loc._id}/rooms`, { name: rn, type: rt, capacity: 30 });
  }
}

// ---- Targets (program-wise per meeting: 210 → 7 batches → 2 trainers) ----
const targetDefs = [
  ["JPR03", "MATH-FND", 210, 180], ["JPR03", "REAS-FND", 90, 90],
  ["KOT02", "PHYS-FND", 150, 120], ["KOT02", "MATH-FND", 90, 60],
  ["IND01", "CHEM-FND", 120, 120], ["JOD02", "MATH-FND", 180, 150],
  ["UDA01", "REAS-FND", 90, 90], ["AJM01", "BIO-FND", 60, 60],
  ["BHI01", "REAS-FND", 120, 90], ["ALW01", "PHYS-FND", 90, 60],
];
for (const [lc, pc, approved, allocated] of targetDefs) {
  await req("PUT", `/api/locations/${locations[lc]._id}/targets`, { program: programs[pc]._id, approved_target: approved, allocated_target: allocated });
}

// ---- Trainers (mockup roster) ----
const trainerDefs = [
  ["Rahul Sharma", ["Mathematics", "Reasoning"], "JPR03", 850],
  ["Neha Malhotra", ["Physics", "Mathematics"], "JPR03", 900],
  ["Vikram Singh", ["Physics"], "KOT02", 800],
  ["Pooja Mehta", ["Chemistry"], "IND01", 850],
  ["Amit Verma", ["Mathematics"], "JPR03", 900],
  ["Rohit Joshi", ["Mathematics", "Reasoning"], "UDA01", 750],
  ["Sanjay Rawat", ["Biology"], "AJM01", 800],
  ["Mohan Jain", ["Chemistry"], "BHI01", 750],
  ["Bhavana Rao", ["Reasoning"], "BHI01", 700],
];
const trainers = {};
for (const [name, skills, home, rate] of trainerDefs) {
  trainers[name] = (await req("POST", "/api/trainers", {
    name, phone: "98" + String(10000000 + Object.keys(trainers).length).slice(0, 8),
    skills, home_location: locations[home]._id, day_rate: rate, available_from: day(-30),
  })).item;
}

// ---- Users (role-wise access) ----
const PW = "Vidysea@123";
for (const u of [
  { name: "Operations Lead", email: "ops@vidysea.com", role: "Operations", can_edit: true },
  { name: "Neha Sharma", email: "spoc.jpr03@vidysea.com", role: "Location", can_edit: true, location_scope: [locations.JPR03._id] },
  { name: "Dr. R. K. Gupta", email: "principal.jpr03@vidysea.com", role: "Location", can_edit: false, location_scope: [locations.JPR03._id] },
  { name: "Shubham Enrollment", email: "enroll@vidysea.com", role: "Enrollment", can_edit: true },
]) {
  await req("POST", "/api/users", { ...u, password: PW });
}

// ---- Candidates (15 per location) ----
const first = ["Aarav", "Vivaan", "Aditya", "Arjun", "Sai", "Krishna", "Ishaan", "Rohan", "Kavya", "Ananya", "Diya", "Priya", "Sneha", "Pooja", "Riya", "Neha", "Tanvi", "Meera", "Rahul", "Karan"];
const last = ["Sharma", "Verma", "Singh", "Gupta", "Jain", "Meena", "Yadav", "Choudhary", "Rathore", "Joshi"];
const candidates = {};
let phone = 7700000001;
for (const [lc, , , ,] of locationDefs.map((d) => d)) {
  candidates[lc] = [];
  const progCodes = targetDefs.filter(([l]) => l === lc).map(([, p]) => p);
  for (let i = 0; i < 15; i++) {
    const name = `${first[(i * 7 + lc.charCodeAt(0)) % first.length]} ${last[(i * 3 + lc.charCodeAt(3)) % last.length]}`;
    const c = (await req("POST", "/api/candidates", {
      name, phone: String(phone++), gender: i % 3 === 0 ? "Female" : "Male",
      location: locations[lc]._id, program: programs[progCodes[i % progCodes.length]]._id,
      source: i % 2 ? "Mobiliser - Ramesh" : "Campaign - August",
    })).item;
    candidates[lc].push(c);
  }
}

// ---- Batches ----
async function makeBatch(lc, pc, trainerName, roomIdx, planStartOffset, memberCount, enrollCount, targetSize = 25) {
  const rooms = (await req("GET", `/api/locations/${locations[lc]._id}/rooms`)).items;
  const b = (await req("POST", "/api/batches", {
    location: locations[lc]._id, program: programs[pc]._id,
    trainer: trainers[trainerName]?._id, room: rooms[roomIdx]._id,
    planned_start: day(planStartOffset), target_size: targetSize,
  })).item;
  const pool = candidates[lc].filter((c) => String(c.program) === String(programs[pc]._id) || true).slice(0, memberCount);
  const memberIds = [];
  for (const c of pool) {
    try {
      const m = (await req("POST", `/api/batches/${b._id}/members`, { candidate: c._id, joined_on: day(planStartOffset) })).item;
      memberIds.push(m._id);
    } catch { /* already active elsewhere */ }
  }
  for (const mid of memberIds.slice(0, enrollCount)) {
    await req("PATCH", `/api/members/${mid}`, { reg_done: true, kyc_done: true, accept_done: true });
  }
  return { batch: b, memberIds };
}

// B1: JPR03 Active with 5 days of logs (gap examples)
const b1 = await makeBatch("JPR03", "MATH-FND", "Rahul Sharma", 0, -5, 12, 12, 12);
await req("POST", `/api/batches/${b1.batch._id}/transition`, { target: "Ready" });
await req("POST", `/api/batches/${b1.batch._id}/transition`, { target: "Active" });

// B2: KOT02 Active, missing yesterday's log (Home queue)
const b2 = await makeBatch("KOT02", "PHYS-FND", "Vikram Singh", 1, -3, 10, 10, 10);
await req("POST", `/api/batches/${b2.batch._id}/transition`, { target: "Ready" });
await req("POST", `/api/batches/${b2.batch._id}/transition`, { target: "Active" });

// B3: IND01 Ready with enrollment failures (Home queue)
const b3 = await makeBatch("IND01", "CHEM-FND", "Pooja Mehta", 2, 3, 10, 6, 12);
await req("PATCH", `/api/members/${b3.memberIds[6]}`, { failed: true, issue: "OTP not received" });
await req("PATCH", `/api/members/${b3.memberIds[7]}`, { failed: true, issue: "Already registered" });
await req("POST", `/api/batches/${b3.batch._id}/transition`, { target: "Ready" });

// B4: JOD02 Planning
await makeBatch("JOD02", "MATH-FND", "Amit Verma", 0, 7, 6, 0, 25);

// B5: UDA01 full cycle → Completed + invoice Raised
const b5 = await makeBatch("UDA01", "REAS-FND", "Rohit Joshi", 1, -2, 8, 8, 8);
await req("POST", `/api/batches/${b5.batch._id}/transition`, { target: "Ready" });
await req("POST", `/api/batches/${b5.batch._id}/transition`, { target: "Active" });

// Backdate actual_start so historical daily logs pass Rule 32 (sample-data-only step,
// done directly in Mongo because the API rightly refuses to fabricate history).
const url = process.env.MONGODB_URL;
await mongoose.connect(url, { dbName: process.env.MONGODB_DB || "center_erp" });
const db = mongoose.connection.db;
const { ObjectId } = mongoose.Types;
const back = (id, days) => db.collection("batches").updateOne({ _id: new ObjectId(String(id)) }, { $set: { actual_start: new Date(Date.now() - days * 86400000) } });
await back(b1.batch._id, 5);
await back(b2.batch._id, 3);
await back(b5.batch._id, 2);

// logs: B1 five days (govt gaps: one red, one amber), skip nothing
const govt = [12, 10, 8, 11, 12];
const present = [12, 12, 12, 12, 12];
for (let i = 5; i >= 1; i--) {
  await req("POST", `/api/batches/${b1.batch._id}/logs`, {
    log_date: day(-i + 0), present_member_ids: b1.memberIds.slice(0, present[5 - i]),
    govt_present: govt[5 - i], actual_topic: `Module ${6 - i}: Algebra basics`, planned_topic: `Module ${6 - i}`,
  }).catch(() => {});
}
// B2: logs for -2 only (yesterday missing → Home queue)
await req("POST", `/api/batches/${b2.batch._id}/logs`, {
  log_date: day(-2), present_member_ids: b2.memberIds.slice(0, 9), govt_present: 9, actual_topic: "Kinematics",
}).catch(() => {});
// B5: complete lifecycle
await req("POST", `/api/batches/${b5.batch._id}/logs`, { log_date: day(-1), present_member_ids: b5.memberIds, govt_present: 8, actual_topic: "Verbal reasoning" }).catch(() => {});
await req("PUT", `/api/batches/${b5.batch._id}/closure`, { assessment_status: "Completed", assessment_date: day(0), appeared: 8, passed: 7 });
await req("POST", `/api/batches/${b5.batch._id}/transition`, { target: "Closing" });
await req("PUT", `/api/batches/${b5.batch._id}/closure`, { certification_status: "Completed", certification_date: day(0), certificates_issued: 7 });
await req("PUT", `/api/batches/${b5.batch._id}/closure`, { ready_for_invoice: true });
await req("PATCH", `/api/batches/${b5.batch._id}/invoice`, { status: "Raised", invoice_no: "INV-2026-0456", raised_on: day(0), amount: 128500 });
await req("POST", `/api/batches/${b5.batch._id}/transition`, { target: "Completed" });

// ---- Trainer requests (mockup: Open Trainer Requests panel) ----
for (const [lc, pc, offset] of [["JOD02", "REAS-FND", 7], ["BHI01", "REAS-FND", 10], ["AJM01", "BIO-FND", 14]]) {
  await req("POST", "/api/trainer-requests", { location: locations[lc]._id, program: programs[pc]._id, required_by_date: day(offset), expected_available_from: day(offset + 7) });
}

// ---- Costs ----
const cats = (await req("GET", "/api/master-lists/cost-categories")).items;
const cat = (n) => cats.find((c) => c.name === n)?._id ?? cats[0]._id;
await req("POST", "/api/costs", { category: cat("Trainer Fee"), amount: 42500, batch: b1.batch._id, location: locations.JPR03._id, note: "Rahul Sharma — 5 days" });
await req("POST", "/api/costs", { category: cat("Rent"), amount: 15000, location: locations.KOT02._id, note: "August rent" });
await req("POST", "/api/costs", { category: cat("TOT Cost"), amount: 8000, trainer: trainers["Bhavana Rao"]._id, note: "Reasoning TOT" });

// ---- Summary ----
for (const col of ["programs", "locations", "rooms", "trainers", "candidates", "batches", "batchmembers", "dailylogs", "users", "trainerrequests", "costentries"]) {
  console.log(col.padEnd(16), await db.collection(col).countDocuments());
}
console.log("\nSample users (password " + PW + "): ops@vidysea.com · spoc.jpr03@vidysea.com · principal.jpr03@vidysea.com (view-only) · enroll@vidysea.com");
await mongoose.disconnect();
