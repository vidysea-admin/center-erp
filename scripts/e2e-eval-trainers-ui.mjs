// Eval: Trainers list + detail (the SCREENS, not the pipeline state machine — that lives in
// e2e-trainer-pipeline.mjs). Before 2026-08-13 this surface had ~6 assertions, all masking.
import { ok, req, adminLogin, finish, stamp, phone } from "./e2e-lib.mjs";

const admin = await adminLogin();
const s = stamp("ET");

const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-EvalTr Loc " + s, approval_status: "Approved", city: "Basti" }, 201)).data.item;
const loc2 = (await req(admin, "POST", "/api/locations", { code: "M" + s, name: "TEST-EvalTr Loc2 " + s, approval_status: "Approved", city: "Deoria" }, 201)).data.item;

// three trainers in three different stages, plus a searchable name/phone
const p1 = phone("91"), p2 = phone("92"), p3 = phone("93");
const t1 = (await req(admin, "POST", "/api/trainers", { name: "TEST-ET Applied " + s, phone: p1, skills: ["ETSkill" + s] }, 201)).data.item;
const t2 = (await req(admin, "POST", "/api/trainers", { name: "TEST-ET Moving " + s, phone: p2, skills: ["ETSkill" + s] }, 201)).data.item;
const t3 = (await req(admin, "POST", "/api/trainers", { name: "TEST-ET Unique" + s, phone: p3, skills: ["ETSkill" + s] }, 201)).data.item;

// [best] search finds by name AND by phone (the two things the team actually types).
const byName = (await req(admin, "GET", `/api/trainers?q=${encodeURIComponent("TEST-ET Unique" + s)}&limit=10`, undefined, 200)).data.items ?? [];
ok("[best] search by name finds exactly the trainer", byName.length === 1 && byName[0]._id === t3._id, `${byName.length} hits`);
const byPhone = (await req(admin, "GET", `/api/trainers?q=${p3}&limit=10`, undefined, 200)).data.items ?? [];
ok("[best] search by phone finds the same trainer", byPhone.some((t) => t._id === t3._id), `${byPhone.length} hits`);

// [best] stage chips: the list's pipeline_status is the same one the detail screen shows.
await req(admin, "PATCH", `/api/trainers/${t2._id}`, { nominated_for_location: loc._id, nominated_for_program: null }, 200);
const move = await req(admin, "POST", `/api/trainers/${t2._id}/transition`, { target: "CV Reviewed" });
ok("[best] a stage move succeeds through the guarded transition route", move.status === 200, `got ${move.status}: ${JSON.stringify(move.data).slice(0, 100)}`);
const listed = (await req(admin, "GET", `/api/trainers?q=${p2}&limit=10`, undefined, 200)).data.items ?? [];
ok("[best] the list shows the moved stage (chip data source)", listed[0]?.pipeline_status === "CV Reviewed", listed[0]?.pipeline_status);

// [best] detail: GET by id returns the full editable record for the drawer.
const detail = (await req(admin, "GET", `/api/trainers/${t1._id}`, undefined, 200)).data.item;
ok("[best] detail carries the drawer's fields", detail.name.startsWith("TEST-ET Applied") && detail.pipeline_status === "Applied" && Array.isArray(detail.skills), JSON.stringify({ p: detail.pipeline_status }));

// [best] drawer edit round-trip: the fields a wrong sheet import needs corrected.
await req(admin, "PATCH", `/api/trainers/${t1._id}`, { qualification: "B.Sc Electronics", email: `et${s}@example.com`, home_location: loc._id, capable_locations: [loc._id, loc2._id], industry_experience_years: 4 }, 200);
const edited = (await req(admin, "GET", `/api/trainers/${t1._id}`, undefined, 200)).data.item;
ok("[best] edit round-trip: qualification/email/experience", edited.qualification === "B.Sc Electronics" && edited.email === `et${s}@example.com` && edited.industry_experience_years === 4, JSON.stringify({ q: edited.qualification, e: edited.email }));
ok("[best] edit round-trip: home + capable locations", String(edited.home_location?._id ?? edited.home_location) === String(loc._id) && (edited.capable_locations ?? []).length === 2, JSON.stringify(edited.capable_locations?.length));

// [worst] duplicate phone is refused (unique index) — one trainer, one number.
const dup = await req(admin, "POST", "/api/trainers", { name: "TEST-ET Dup " + s, phone: p1, skills: ["ETSkill" + s] });
ok("[worst] duplicate phone refused on create", dup.status >= 400, `got ${dup.status}`);
const dupPatch = await req(admin, "PATCH", `/api/trainers/${t3._id}`, { phone: p1 });
ok("[worst] duplicate phone refused on edit too", dupPatch.status >= 400, `got ${dupPatch.status}`);

// [worst] pipeline_status is NOT writable through the drawer PATCH — stages move only through
// the guarded transition route. Found live 2026-08-13: a plain PATCH could certify anyone,
// skipping the docs gate, the NSDC round-trip, and Rule T7. The field is silently dropped now.
await req(admin, "PATCH", `/api/trainers/${t1._id}`, { pipeline_status: "Certified" }, 200);
const sneak = (await req(admin, "GET", `/api/trainers/${t1._id}`, undefined, 200)).data.item;
ok("[worst] a stage jump by plain PATCH is dropped — no certification without the journey", sneak.pipeline_status === "Applied", `pipeline now: ${sneak.pipeline_status}`);

// [avg] pagination contract: total is the truth, limit only pages it.
const page = (await req(admin, "GET", "/api/trainers?limit=1", undefined, 200)).data;
ok("[avg] limit=1 returns one row but the real total", page.items.length === 1 && page.total >= 3, `total=${page.total}`);
const pageAll = (await req(admin, "GET", "/api/trainers?limit=2000", undefined, 200)).data;
ok("[avg] full-scale fetch returns every trainer (no hidden cap)", pageAll.items.length === pageAll.total || pageAll.total > 2000, `items=${pageAll.items.length} total=${pageAll.total}`);

// [avg] filter by pipeline_status narrows correctly.
const applied = (await req(admin, "GET", "/api/trainers?pipeline_status=CV%20Reviewed&limit=2000", undefined, 200)).data.items ?? [];
ok("[avg] pipeline_status filter returns only that stage", applied.length > 0 && applied.every((t) => t.pipeline_status === "CV Reviewed"), JSON.stringify([...new Set(applied.map((t) => t.pipeline_status))]));


// ---- 2026-08-13 list-UX cycle: preset filter contracts + the nomination input (F-A1) ----
// [best] ?status= narrows server-side (the Available pill's deep-link contract).
const avail = (await req(admin, "GET", "/api/trainers?status=Available&limit=2000", undefined, 200)).data.items ?? [];
ok("[best] status filter returns only that status", avail.length > 0 && avail.every((t) => t.status === "Available"), JSON.stringify([...new Set(avail.map((t) => t.status))]));

// [best] F-A1: the nomination pair (centre x job role) is settable through plain PATCH — the
// new "Set nomination" form's exact call — and drives the nominated_for_location filter.
const nprog = (await req(admin, "POST", "/api/programs", { code: "NP" + s, name: "EvalTr NomProg " + s, trainer_skill: "ETSkill" + s }, 201)).data.item;
await req(admin, "PATCH", `/api/trainers/${t3._id}`, { nominated_for_location: loc2._id, nominated_for_program: nprog._id }, 200);
const nomRead = (await req(admin, "GET", `/api/trainers/${t3._id}`, undefined, 200)).data.item;
ok("[best] nomination pair lands and reads back populated",
  String(nomRead.nominated_for_location?._id ?? nomRead.nominated_for_location) === String(loc2._id)
  && String(nomRead.nominated_for_program?._id ?? nomRead.nominated_for_program) === String(nprog._id),
  JSON.stringify({ l: nomRead.nominated_for_location?.name, p: nomRead.nominated_for_program?.name }));
const byNom = (await req(admin, "GET", `/api/trainers?nominated_for_location=${loc2._id}&limit=100`, undefined, 200)).data.items ?? [];
ok("[best] the location page's trainer-slots query finds them by nomination", byNom.some((t) => String(t._id) === String(t3._id)), `${byNom.length} hits`);
await req(admin, "PATCH", `/api/trainers/${t3._id}`, { nominated_for_location: null, nominated_for_program: null }, 200);
const nomCleared = (await req(admin, "GET", `/api/trainers/${t3._id}`, undefined, 200)).data.item;
ok("[avg] nomination can be cleared again (wrong pick is reversible)", nomCleared.nominated_for_location == null && nomCleared.nominated_for_program == null, JSON.stringify(nomCleared.nominated_for_location));

finish();
