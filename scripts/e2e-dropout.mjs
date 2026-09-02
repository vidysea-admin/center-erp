// Dropout suggestion - the behavioural suite.
//
// PROVENANCE, because it matters: this began as the CHECKER's own probe against
// qa-dropout-suggestion cycle 1. It found three things the maker's pins could not, and it is
// promoted here so none of them can come back:
//   * [P7] an identical re-upload used to flag a member who was ACTIVELY ATTENDING as having
//          stopped coming (QA-1785) - and the maker's own pin asserted that bug as correct.
//   * [P2] cannot_reach_bar had never executed at all (QA-1791).
//   * [P4] the QA-085 estimate-exclusion guard could be DELETED outright with every pin still
//          green (QA-1787).
//
// THE WHOLE POINT OF THIS FILE IS ITS BATCH: it carries a 09:00-13:00 slot, so slotHoursPerDay()
// is non-null, the projection arm can fire, and an estimate-basis member is genuinely flaggable.
// e2e-govt.mjs deliberately keeps a SLOTLESS batch (QA-085 pins that), which is precisely why
// half of this feature was invisible there. Do not 'simplify' this by dropping the slot.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const localDate = (ms = Date.now()) => { const n = new Date(ms); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; };
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + "   " + x); } };

async function login(email, password) {
  const csrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email, password }), redirect: "manual",
  });
  const session = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]).flat().filter(Boolean)
    .map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  return session ? [csrfCookie, session].join("; ") : null;
}
async function req(cookie, method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function upload(cookie, fields) {
  const fd = new FormData();
  if (fields.confirm === "1" && fields.accept_name_match === undefined) fields = { ...fields, accept_name_match: "1" };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(BASE + "/api/govt-attendance", { method: "POST", headers: { cookie }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
if (!admin) { console.log("FAIL  admin login"); process.exit(1); }

const S = Date.now().toString().slice(-6);
const TC = `TD9${S}`;
const NAME = `D${S}`;

// A CSV in the portal's exact shape. rows: [name, canId, workingDays, daysPresent, "HH:MM:SS"]
const HEAD = readFileSync(path.join(HERE, "fixtures", "govt-attendance-sample.csv"), "utf8").split("\n")[0];
function csv(rows) {
  const lines = [HEAD];
  rows.forEach((r, i) => {
    lines.push(`${i + 1},TESTORG Gurugram -${TC},${1000000 + i},${r[0]},${r[1]},Trainee,Trainee,${r[2]},${r[3]},${r[3]},0,${r[4]},0,00:00:00,"\n\t\t\t\t\t\t\t Details\n\t\t\t\t\t\t\t"`);
  });
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- setup
const loc = (await req(admin, "POST", "/api/locations", {
  name: `${NAME} Centre`, code: `DT${S}`, external_id: TC, city: "Gurugram", state: "Haryana",
  approval_status: "Approved", operational_status: "Active",
})).data.item;
ok("centre", !!loc?._id, JSON.stringify(loc).slice(0, 200));

const programs = (await req(admin, "GET", "/api/programs?limit=10")).data.items ?? [];
const program = programs[0];
console.log("PROGRAM", JSON.stringify({ name: program?.name, hours: program?.hours, duration_days: program?.duration_days, scheme: program?.scheme }));

const room = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: `${NAME} Lab`, type: "Lab", capacity: 30 })).data.item ?? {};
const trainer = (await req(admin, "POST", "/api/trainers", {
  name: `${NAME} Trainer`, phone: `9${S.slice(1)}0001`, skills: ["Testing"], home_location: loc._id,
  pipeline_status: "Certified", max_concurrent_batches: 4, available_from: localDate(Date.now() - 30 * 86400_000),
})).data.item;

// THE POINT OF THIS PROBE: a batch WITH A TIME SLOT, so slotHoursPerDay() is non-null and the
// cannot_reach_bar projection arm can actually fire. The maker's fixture batch has no slot.
const batch = (await req(admin, "POST", "/api/batches", {
  location: loc._id, program: program._id, target_size: 5, trainer: trainer._id, room: room._id,
  planned_start: localDate(), slot_start: "09:00", slot_end: "13:00",
})).data.item;
ok("batch created WITH a 09:00-13:00 slot (4 h/day)", !!batch?._id, JSON.stringify(batch).slice(0, 300));
const bfull = (await req(admin, "GET", `/api/batches/${batch._id}`)).data.item;
ok("...and the slot actually persisted", bfull?.slot_start === "09:00" && bfull?.slot_end === "13:00",
  JSON.stringify({ s: bfull?.slot_start, e: bfull?.slot_end }));

const people = [
  { key: "Frozen",   name: `${NAME} Frozen`,   id: `CAN_${S}0001` },
  { key: "Mover",    name: `${NAME} Mover`,    id: `CAN_${S}0002` },
  { key: "Departed", name: `${NAME} Departed`, id: `CAN_${S}0003` },
  { key: "NoPortal", name: `${NAME} NoPortal`, id: null },   // never appears in any file -> estimate/no basis
];
const mem = {};
for (const [i, p] of people.entries()) {
  const c = (await req(admin, "POST", "/api/candidates", {
    name: p.name, phone: `9${S.slice(1)}2${String(i).padStart(3, "0")}`, location: loc._id, program: program._id,
    ...(p.id ? { sidh_candidate_id: p.id } : {}),
  })).data.item;
  const m = (await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: c._id, joined_on: localDate(Date.now() - 20 * 86400_000) }, 201)).data.item;
  mem[p.key] = { cand: c, member: m };
}
ok("4 members on the roster", Object.keys(mem).length === 4);

const get = async () => (await req(admin, "GET", `/api/batches/${batch._id}/attendance`)).data;
const sigOf = (d, key) => (d.members ?? []).find((m) => m.name === `${NAME} ${key}`);

// ---------------------------------------------------------------- IMPORT 1
// Frozen: 1 day, ~4h.  Mover: 2 days ~8h.  Departed: 1 day ~4h.
const f1 = csv([
  [`${NAME} Frozen`,   `CAN_${S}0001`, 8, 1, "04:00:00"],
  [`${NAME} Mover`,    `CAN_${S}0002`, 8, 2, "08:00:00"],
  [`${NAME} Departed`, `CAN_${S}0003`, 8, 1, "04:00:00"],
]);
const up1 = await upload(admin, { file: new File([Buffer.from(f1)], "probe-1.csv", { type: "text/csv" }), batch: batch._id, confirm: "1", period_label: `probe1 ${S}` });
ok("import 1 committed", up1.status === 200 || up1.status === 201, JSON.stringify(up1.data).slice(0, 300));

const d1 = await get();
console.log("REQUIRED_HOURS", d1.required_hours, "MIN_PCT", d1.min_attendance_pct);
console.log("AFTER IMPORT 1:", JSON.stringify((d1.members ?? []).map((m) => ({ n: m.name.split(" ").pop(), basis: m.basis, q: m.qualified, h: m.attended_hours, sig: m.dropout_signal }))));

// [P1] ONE import must produce NO stopped_coming anywhere (absence of evidence != evidence of absence)
ok("[P1] a single import produces NO stopped_coming signal for anybody",
  (d1.members ?? []).every((m) => !m.dropout_signal || m.dropout_signal.stopped_coming === false),
  JSON.stringify((d1.members ?? []).filter((m) => m.dropout_signal?.stopped_coming).map((m) => m.name)));

// [P2] THE UNPROVEN ARM: cannot_reach_bar must fire on this slotted batch after ONE import.
const fr1 = sigOf(d1, "Frozen");
ok("[P2] cannot_reach_bar FIRES on a batch that has a time slot (the arm the manifest calls unproven)",
  fr1?.dropout_signal?.cannot_reach_bar === true, JSON.stringify(fr1?.dropout_signal));
ok("[P2b] ...and it projects a real number of hours rather than null",
  typeof fr1?.dropout_signal?.projected_hours === "number" && fr1.dropout_signal.projected_hours > 0,
  JSON.stringify(fr1?.dropout_signal));
ok("[P2c] ...and the projection is arithmetically right: attended + remaining_days * 4 h/day",
  fr1?.dropout_signal && fr1.dropout_signal.projected_hours === Math.round((fr1.attended_hours ?? 0) + (fr1.dropout_signal.remaining_days ?? 0) * 4),
  JSON.stringify({ attended: fr1?.attended_hours, sig: fr1?.dropout_signal }));

// [P3] someone who CAN still reach the bar must NOT be flagged by the projection arm
const mv1 = sigOf(d1, "Mover");
console.log("MOVER after import1:", JSON.stringify(mv1?.dropout_signal), "hours", mv1?.attended_hours);

// [P4] the estimate/no-portal member is never flagged
const np1 = sigOf(d1, "NoPortal");
ok("[P4] a member with no portal row is NEVER suggested (basis is not 'portal')",
  np1 && np1.basis !== "portal" && np1.dropout_signal === null, JSON.stringify({ basis: np1?.basis, sig: np1?.dropout_signal }));

// ---------------------------------------------------------------- IMPORT 2: GENUINE PROGRESS for Mover, frozen for Frozen
const f2 = csv([
  [`${NAME} Frozen`,   `CAN_${S}0001`, 12, 1, "04:00:00"],   // unchanged -> stopped
  [`${NAME} Mover`,    `CAN_${S}0002`, 12, 6, "24:00:00"],   // real progress -> must NOT be stopped
  [`${NAME} Departed`, `CAN_${S}0003`, 12, 1, "04:00:00"],
]);
const up2 = await upload(admin, { file: new File([Buffer.from(f2)], "probe-2.csv", { type: "text/csv" }), batch: batch._id, confirm: "1", period_label: `probe2 ${S}` });
ok("import 2 committed", up2.status === 200 || up2.status === 201, JSON.stringify(up2.data).slice(0, 300));

const d2 = await get();
console.log("AFTER IMPORT 2:", JSON.stringify((d2.members ?? []).map((m) => ({ n: m.name.split(" ").pop(), basis: m.basis, q: m.qualified, h: m.attended_hours, sig: m.dropout_signal }))));

const fr2 = sigOf(d2, "Frozen"), mv2 = sigOf(d2, "Mover");
ok("[P5] a cumulative total that did NOT move across two imports is flagged stopped_coming",
  fr2?.dropout_signal?.stopped_coming === true, JSON.stringify(fr2?.dropout_signal));
ok("[P6] THE CONVERSE: a genuine second import WITH progress is NOT flagged stopped_coming",
  mv2 && (mv2.dropout_signal === null || mv2.dropout_signal.stopped_coming === false),
  JSON.stringify({ hours: mv2?.attended_hours, sig: mv2?.dropout_signal }));

// ---------------------------------------------------------------- IMPORT 3: THE SAME FILE AS IMPORT 2, byte-identical content
// The manifest claims: "two rows from the SAME upload are ONE observation, so re-importing the
// same file must not look like another week of no progress." Test exactly that.
const up3 = await upload(admin, { file: new File([Buffer.from(f2)], "probe-3-identical.csv", { type: "text/csv" }), batch: batch._id, confirm: "1", period_label: `probe3 ${S}` });
ok("import 3 (identical content to import 2) committed", up3.status === 200 || up3.status === 201, JSON.stringify(up3.data).slice(0, 300));

const d3 = await get();
console.log("AFTER IMPORT 3 (IDENTICAL RE-UPLOAD):", JSON.stringify((d3.members ?? []).map((m) => ({ n: m.name.split(" ").pop(), h: m.attended_hours, sig: m.dropout_signal }))));
const mv3 = sigOf(d3, "Mover");
ok("[P7] MANIFEST CLAIM: re-importing the SAME file does not make a person who was PROGRESSING look stopped",
  mv3 && (mv3.dropout_signal === null || mv3.dropout_signal.stopped_coming === false),
  "Mover -> " + JSON.stringify(mv3?.dropout_signal));

// ---------------------------------------------------------------- the departed exclusion
const drop = await req(admin, "POST", `/api/members/${mem.Departed.member._id}/drop`,
  { left_on: localDate(), drop_reason: "Other" });
console.log("DROP status", drop.status, JSON.stringify(drop.data).slice(0, 200));
const d4 = await get();
const dp = sigOf(d4, "Departed");
ok("[P8-pre] the drop actually took effect (non-vacuous)", !!dp?.left_on, JSON.stringify({ status: drop.status, left_on: dp?.left_on }));
ok("[P8] a member who has already LEFT is never suggested",
  !!dp?.left_on && dp.dropout_signal === null,
  JSON.stringify({ left_on: dp?.left_on, sig: dp?.dropout_signal }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
