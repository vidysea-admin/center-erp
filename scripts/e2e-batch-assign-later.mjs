// mtg-a2 (meeting 2026-10-06, Karunn sir + Manish + Umesh): "trainer hatao ek baar aap. 'assign
// later'. kar do, bana do batch" / "room bhi 'assign later' kar do". Umesh refused a clash override:
// "ye cheez to override karana sahi nahi hai".
//
// What this suite pins, at BOTH doors that can put a trainer or a room on a batch (POST /api/batches
// and PATCH /api/batches/[id]):
//   1. a batch is creatable with the trainer and/or the room left unassigned;
//   2. the clash check runs only on a resource that is actually assigned, and a clash is refused
//      (409) at create AND at a later assignment, with NO override key that gets around it;
//   3. the refusal NAMES the batch that holds the resource, says until when, and hints
//      "Assign later";
//   4. a non-clashing assignment still works, and clearing a resource (assign later again) works.
//
// Every identity (codes, phones, e-mails) comes from the run stamp, never a fixed literal: a fixed
// APAAR in the previous unit collided with another suite in the wall.
import fs from "node:fs";
import { adminLogin, login, req, ok, finish, stamp, phone, today } from "./e2e-lib.mjs";

const admin = await adminLogin();
const s = stamp("MA2");

const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "AssignLater Prog " + s, trainer_skill: "MA2Skill" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-AssignLater " + s, approval_status: "Approved", city: "Meerut" }, 201)).data.item;
const mkTrainer = async (tag, pre, extra = {}) =>
  (await req(admin, "POST", "/api/trainers", { name: `MA2 ${tag} ${s}`, phone: phone(pre), skills: ["MA2Skill" + s], ...extra }, 201)).data.item;
const mkRoom = async (tag) =>
  (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: `MA2 ${tag} ${s}`, type: "Classroom", capacity: 30 }, 201)).data.item;

// Cap 1 so that ONE existing batch makes the next booking a clash by the concurrency rule alone.
const T1 = await mkTrainer("T1", "62", { max_concurrent_batches: 1 }); // the clash target (cap path)
const T2 = await mkTrainer("T2", "63", { max_concurrent_batches: 1 }); // a free trainer to assign later
const T3 = await mkTrainer("T3", "64", { max_concurrent_batches: 1 }); // trainer with room left unassigned
const TS = await mkTrainer("TS", "65");                                // the slot-clash target
const R1 = await mkRoom("R1"); // the clash target
const R2 = await mkRoom("R2"); // a free room to assign later
const R3 = await mkRoom("R3"); // room with trainer left unassigned

const mk = (extra) => ({ location: loc._id, program: prog._id, planned_start: today(), target_size: 3, ...extra });
// The holder batches below start a few days AFTER the batch being created, so each holder's end date is
// different from every other batch's: a message that named the wrong batch's end date cannot pass
// `until()` by luck. Helpers tolerate a missing holder (a failed fixture create) so a mutant that breaks
// fixture creation turns arms red instead of crashing the suite.
const dayPlus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const untilOf = (b) => (b?.planned_end ? new Date(b.planned_end).toDateString() : "<no holder>"); // the same format the server prints (TZ=Asia/Kolkata in the wall)
const names = (msg, b) => !!b?.code && (msg ?? "").includes(b.code);
const hint = (msg) => /assign later/i.test(msg ?? "");
const until = (msg, b) => !!b?.planned_end && (msg ?? "").includes(untilOf(b));

// ------------------------------------------------------------ 1. creatable with "assign later"
const both = await req(admin, "POST", "/api/batches", mk({}), 201);
ok("R2-C1: a batch is created with the trainer AND the room left on assign later",
  both.status === 201 && both.data.item?.trainer == null && both.data.item?.room == null,
  `(trainer ${JSON.stringify(both.data.item?.trainer)}, room ${JSON.stringify(both.data.item?.room)})`);

const noTrainer = await req(admin, "POST", "/api/batches", mk({ trainer: "", room: R3._id }), 201);
ok("R2-C2: the trainer left on assign later (empty value), the room assigned, creates",
  noTrainer.status === 201 && noTrainer.data.item?.trainer == null && String(noTrainer.data.item?.room) === String(R3._id),
  `(trainer ${JSON.stringify(noTrainer.data.item?.trainer)}, room ${JSON.stringify(noTrainer.data.item?.room)})`);

const noRoom = await req(admin, "POST", "/api/batches", mk({ trainer: T3._id, room: "" }), 201);
ok("R2-C3: the room left on assign later (empty value), the trainer assigned, creates",
  noRoom.status === 201 && noRoom.data.item?.room == null && String(noRoom.data.item?.trainer) === String(T3._id),
  `(trainer ${JSON.stringify(noRoom.data.item?.trainer)}, room ${JSON.stringify(noRoom.data.item?.room)})`);

const nullBoth = await req(admin, "POST", "/api/batches", mk({ trainer: null, room: null }), 201);
ok("R2-C4: explicit nulls for both (what the form's undefined/empty becomes) create too",
  nullBoth.status === 201 && nullBoth.data.item?.trainer == null && nullBoth.data.item?.room == null);

// ------------------------------------------------------------ 2. a clash is still refused, and says so well
const heldT = (await req(admin, "POST", "/api/batches", mk({ trainer: T1._id, planned_start: dayPlus(3) }), 201)).data.item;
const t2 = await req(admin, "POST", "/api/batches", mk({ trainer: T1._id }), 409);
ok("R2-T1: an assigned trainer who is already booked is REFUSED at create (409)", t2.status === 409);
ok("R2-T2: the trainer refusal NAMES the batch that holds the trainer", names(t2.data.error, heldT), `(${JSON.stringify(t2.data.error)})`);
ok("R2-T3: the trainer refusal says UNTIL WHEN (the holding batch's end date)", until(t2.data.error, heldT), `(want ${untilOf(heldT)} in ${JSON.stringify(t2.data.error)})`);
ok("R2-T4: the trainer refusal hints Assign later", hint(t2.data.error), `(${JSON.stringify(t2.data.error)})`);

// the time-slot door of the same rule
const slotHeld = (await req(admin, "POST", "/api/batches", mk({ trainer: TS._id, slot_start: "09:00", slot_end: "13:00", planned_start: dayPlus(5) }), 201)).data.item;
const ts2 = await req(admin, "POST", "/api/batches", mk({ trainer: TS._id, slot_start: "10:00", slot_end: "14:00" }), 409);
ok("R2-T5: a same-time slot clash is refused (409)", ts2.status === 409);
ok("R2-T6: the slot-clash refusal names the batch, says until when, and hints Assign later",
  names(ts2.data.error, slotHeld) && until(ts2.data.error, slotHeld) && hint(ts2.data.error), `(${JSON.stringify(ts2.data.error)})`);
// The sessions-a-day door and the daily-hours door are reached by a SECOND, non-overlapping slot
// (14:00-18:00), so the time-clash rule passes and the per-day rules are what refuse. Their limits are
// Admin defaults (2 sessions, 8 hours), so each is tightened for one assertion and put back.
const TD = await mkTrainer("TD", "66");
const dayHeld = (await req(admin, "POST", "/api/batches", mk({ trainer: TD._id, slot_start: "09:00", slot_end: "13:00", planned_start: dayPlus(6) }), 201)).data.item;
const dBefore = (await req(admin, "GET", "/api/defaults", undefined, 200)).data.item;
let perDay, perHours;
try {
  await req(admin, "PUT", "/api/defaults", { max_batches_per_day: 1 }, 200);
  perDay = await req(admin, "POST", "/api/batches", mk({ trainer: TD._id, slot_start: "14:00", slot_end: "18:00" }), 409);
  await req(admin, "PUT", "/api/defaults", { max_batches_per_day: dBefore.max_batches_per_day ?? 2, max_daily_hours: 6 }, 200);
  perHours = await req(admin, "POST", "/api/batches", mk({ trainer: TD._id, slot_start: "14:00", slot_end: "18:00" }), 409);
} finally {
  await req(admin, "PUT", "/api/defaults", { max_batches_per_day: dBefore.max_batches_per_day ?? 2, max_daily_hours: dBefore.max_daily_hours ?? 8 }, 200);
}
ok("R2-T7: the sessions-a-day refusal names the batch, says until when, and hints Assign later",
  perDay?.status === 409 && names(perDay.data.error, dayHeld) && until(perDay.data.error, dayHeld) && hint(perDay.data.error), `(${perDay?.status} ${JSON.stringify(perDay?.data?.error)})`);
ok("R2-T8: the daily-hours refusal names the batch, says until when, and hints Assign later",
  perHours?.status === 409 && names(perHours.data.error, dayHeld) && until(perHours.data.error, dayHeld) && hint(perHours.data.error), `(${perHours?.status} ${JSON.stringify(perHours?.data?.error)})`);

const heldR = (await req(admin, "POST", "/api/batches", mk({ room: R1._id, planned_start: dayPlus(4) }), 201)).data.item;
const r2 = await req(admin, "POST", "/api/batches", mk({ room: R1._id }), 409);
ok("R2-R1: an assigned room that is already booked is REFUSED at create (409)", r2.status === 409);
ok("R2-R2: the room refusal NAMES the batch that holds the room", names(r2.data.error, heldR), `(${JSON.stringify(r2.data.error)})`);
ok("R2-R3: the room refusal says UNTIL WHEN", until(r2.data.error, heldR), `(want ${untilOf(heldR)} in ${JSON.stringify(r2.data.error)})`);
ok("R2-R4: the room refusal hints Assign later", hint(r2.data.error), `(${JSON.stringify(r2.data.error)})`);
ok("R2-R5: the room refusal does not open with an internal rule number", !/^\s*Rule\s*\d+/i.test(r2.data.error ?? ""), `(${JSON.stringify(r2.data.error)})`);

// ------------------------------------------------------------ 3. NO override
const f1 = await req(admin, "POST", "/api/batches", mk({ trainer: T1._id, override: true, force: true, allow_clash: true, ignore_clash: true }), 409);
const f2 = await req(admin, "POST", "/api/batches", mk({ room: R1._id, override: true, force: true, allow_clash: true, ignore_clash: true }), 409);
ok("R2-N1: no override key gets a trainer clash through (still 409)", f1.status === 409);
ok("R2-N2: no override key gets a room clash through (still 409)", f2.status === 409);
const listAfter = (await req(admin, "GET", `/api/batches?location=${loc._id}&limit=500`, undefined, 200)).data.items ?? [];
ok("R2-N3: the refused attempts wrote no batch (trainer T1 holds exactly one, room R1 exactly one)",
  listAfter.filter((b) => String(b.trainer?._id ?? b.trainer) === String(T1._id)).length === 1
  && listAfter.filter((b) => String(b.room?._id ?? b.room) === String(R1._id)).length === 1);

// ------------------------------------------------------------ 4. the EDIT door runs the SAME rule
const later = (await req(admin, "POST", "/api/batches", mk({}), 201)).data.item;
const p1 = await req(admin, "PATCH", `/api/batches/${later._id}`, { trainer: T1._id }, 409);
ok("R2-P1: assigning a booked trainer LATER is refused (409)", p1.status === 409);
ok("R2-P2: ...and names the holding batch, says until when, hints Assign later",
  names(p1.data.error, heldT) && until(p1.data.error, heldT) && hint(p1.data.error), `(${JSON.stringify(p1.data.error)})`);
const p2 = await req(admin, "PATCH", `/api/batches/${later._id}`, { room: R1._id }, 409);
ok("R2-P3: assigning a booked room LATER is refused (409), naming the batch + until + Assign later",
  p2.status === 409 && names(p2.data.error, heldR) && until(p2.data.error, heldR) && hint(p2.data.error), `(${p2.status} ${JSON.stringify(p2.data.error)})`);
const p3 = await req(admin, "PATCH", `/api/batches/${later._id}`, { trainer: T1._id, override: true, force: true }, 409);
ok("R2-P4: no override key on the edit door either", p3.status === 409);
const still = (await req(admin, "GET", `/api/batches/${later._id}`, undefined, 200)).data.item;
ok("R2-P5: the refused assignments wrote nothing (trainer and room still unassigned)",
  still?.trainer == null && still?.room == null, `(trainer ${JSON.stringify(still?.trainer)}, room ${JSON.stringify(still?.room)})`);

// a non-clashing later assignment works
const a1 = await req(admin, "PATCH", `/api/batches/${later._id}`, { trainer: T2._id }, 200);
const a2 = await req(admin, "PATCH", `/api/batches/${later._id}`, { room: R2._id }, 200);
ok("R2-P6: a NON-clashing trainer and room assigned later are accepted and stored",
  String(a1.data.item?.trainer) === String(T2._id) && String(a2.data.item?.room) === String(R2._id),
  `(trainer ${JSON.stringify(a1.data.item?.trainer)}, room ${JSON.stringify(a2.data.item?.room)})`);
// and back to assign later
const c1 = await req(admin, "PATCH", `/api/batches/${later._id}`, { trainer: null, room: null }, 200);
ok("R2-P7: clearing both back to assign later works", c1.data.item?.trainer == null && c1.data.item?.room == null,
  `(trainer ${JSON.stringify(c1.data.item?.trainer)}, room ${JSON.stringify(c1.data.item?.room)})`);

// a clash disappears when the holder is cancelled: the rule is about LIVE bookings
await req(admin, "POST", `/api/batches/${heldR._id}/transition`, { target: "Cancelled", reason: "assign-later test" }, 200);
const free = await req(admin, "POST", "/api/batches", mk({ room: R1._id }), 201);
ok("R2-P8: once the holding batch is cancelled the same room is bookable again", free.status === 201);

// ------------------------------------------------------------ 5. personas
// Operations scoped to this one centre is the persona that really does create and edit batches (the
// Location role has NO batch edit, decided 2026-08-13). It must get exactly what Admin got above.
const opsEmail = `ma2.ops.${s.toLowerCase()}@vidysea-test.local`;
await req(admin, "POST", "/api/users", { name: "TEST-MA2 Ops " + s, email: opsEmail, password: "CiOnly@123", role: "Operations", can_edit: true, location_scope: [loc._id] }, 201);
const ou = await login(opsEmail, "CiOnly@123");
ok("R2-U0: the scoped Operations user can sign in", !!ou);
if (ou) {
  const o1 = await req(ou, "POST", "/api/batches", mk({}), 201);
  ok("R2-U1: an Operations user creates a batch at their centre with trainer and room on assign later", o1.status === 201);
  const o2 = await req(ou, "POST", "/api/batches", mk({ trainer: T1._id }), 409);
  ok("R2-U2: the same user is refused a booked trainer, naming the batch + until + Assign later",
    o2.status === 409 && names(o2.data.error, heldT) && until(o2.data.error, heldT) && hint(o2.data.error), `(${o2.status} ${JSON.stringify(o2.data.error)})`);
  const ob = o1.data.item;
  const o3 = ob ? await req(ou, "PATCH", `/api/batches/${ob._id}`, { trainer: T1._id }, 409) : { status: 0, data: {} };
  ok("R2-U3: that user's later assignment of the booked trainer is refused with the same message",
    o3.status === 409 && names(o3.data.error, heldT) && until(o3.data.error, heldT) && hint(o3.data.error), `(${o3.status} ${JSON.stringify(o3.data.error)})`);
  const o4 = ob ? await req(ou, "PATCH", `/api/batches/${ob._id}`, { trainer: T2._id }, 200) : { status: 0, data: {} };
  ok("R2-U4: ...and a non-clashing assignment by that user works", o4.status === 200);
}
// The Location role must NOT gain batch creation or editing through this unit (it has none).
const locEmail = `ma2.loc.${s.toLowerCase()}@vidysea-test.local`;
await req(admin, "POST", "/api/users", { name: "TEST-MA2 Loc " + s, email: locEmail, password: "CiOnly@123", role: "Location", location_scope: [loc._id] }, 201);
const lu = await login(locEmail, "CiOnly@123");
ok("R2-L0: the scoped Location user can sign in", !!lu);
if (lu) {
  const l1 = await req(lu, "POST", "/api/batches", mk({}), 403);
  ok("R2-L1: a Location user still cannot create a batch, with or without a trainer (assign later is not a way in)", l1.status === 403);
  const l2 = await req(lu, "PATCH", `/api/batches/${later._id}`, { trainer: T2._id }, 403);
  ok("R2-L2: ...nor assign a trainer to an existing batch", l2.status === 403);
}

// ------------------------------------------------------------ 6. the screens offer "Assign later" (structural)
// Both the create drawer and the batch detail edit form must label the empty option so, for trainer
// AND room: the refusal text tells the operator to choose it, and a bare dash does not say that.
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const createPage = src("../src/app/(app)/batches/page.tsx");
const detailPage = src("../src/app/(app)/batches/[id]/page.tsx");
const optionsLabelled = (page, field) => {
  const m = new RegExp(`value=\\{form\\.${field}(?![A-Za-z_])[\\s\\S]{0,260}?<option value="">([^<]*)</option>`).exec(page);
  return m ? m[1] : null;
};
ok("R2-S1: the create drawer's trainer select has an Assign later option", /assign later/i.test(optionsLabelled(createPage, "trainer") ?? ""), `(label ${JSON.stringify(optionsLabelled(createPage, "trainer"))})`);
ok("R2-S2: the create drawer's room select has an Assign later option", /assign later/i.test(optionsLabelled(createPage, "room") ?? ""), `(label ${JSON.stringify(optionsLabelled(createPage, "room"))})`);
ok("R2-S3: the batch detail edit form's trainer select has an Assign later option", /assign later/i.test(optionsLabelled(detailPage, "trainer") ?? ""), `(label ${JSON.stringify(optionsLabelled(detailPage, "trainer"))})`);
ok("R2-S4: the batch detail edit form's room select has an Assign later option", /assign later/i.test(optionsLabelled(detailPage, "room") ?? ""), `(label ${JSON.stringify(optionsLabelled(detailPage, "room"))})`);

finish();
