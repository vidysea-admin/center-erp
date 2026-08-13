// Eval: Notifications — the inbox itself. Until 2026-08-13 alerts were only ever asserted as a
// side effect of another flow (~8 assertions total); nothing tested ordering, ack/resolve, role
// addressing, or the type filter. This suite also pins the severity-ordering fix: sort by rank,
// not lexicographically (where "critical" sorted BELOW "info").
import { ok, req, adminLogin, login, finish, stamp, phone, today } from "./e2e-lib.mjs";

const admin = await adminLogin();
const s = stamp("EN");

// ---- fixture: a trainer request fires an instant Operations/Admin alert ----
const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "EvalNotif Prog " + s, trainer_skill: "ENSkill" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-EvalNotif Loc " + s, approval_status: "Approved", city: "Kota" }, 201)).data.item;
const treq = (await req(admin, "POST", "/api/trainer-requests", { location: loc._id, program: prog._id, required_by_date: today() }, 201)).data.item;

// [best] creation: the request is announced the moment it exists, addressed to the doers.
const inbox = (await req(admin, "GET", "/api/notifications?status=all&type=trainer_request_new", undefined, 200)).data.items ?? [];
const mine = inbox.find((n) => String(n.entity_id) === String(treq._id));
ok("[best] trainer request raises an instant notification", !!mine, `${inbox.length} trainer_request_new alerts, none for this request`);
ok("[best] …addressed to Admin (role_target)", !!mine && mine.role_target?.includes("Admin"), JSON.stringify(mine?.role_target));
ok("[best] …carrying the location for Rule-38 scoping", !!mine && String(mine.location?._id ?? mine.location) === String(loc._id), JSON.stringify(mine?.location));

// [best] severity ordering: critical outranks warning outranks info — by rank, not alphabet.
const all = (await req(admin, "GET", "/api/notifications?status=all", undefined, 200)).data.items ?? [];
const rank = { critical: 0, warning: 1, info: 2 };
const ranks = all.map((n) => rank[n.severity] ?? 3);
ok("[best] inbox is sorted most-severe first (the lexicographic-sort regression)", ranks.every((r, i) => i === 0 || ranks[i - 1] <= r),
  `first out-of-order at index ${ranks.findIndex((r, i) => i > 0 && ranks[i - 1] > r)}`);

// [best] ack flow: Acknowledged keeps it in the open view; Resolved removes it.
if (mine) {
  await req(admin, "POST", `/api/notifications/${mine._id}`, { status: "Acknowledged" }, 200);
  const open1 = (await req(admin, "GET", "/api/notifications?status=open", undefined, 200)).data.items ?? [];
  ok("[best] Acknowledged stays in the open view (seen ≠ done)", open1.some((n) => String(n._id) === String(mine._id)));
  await req(admin, "POST", `/api/notifications/${mine._id}`, { status: "Resolved" }, 200);
  const open2 = (await req(admin, "GET", "/api/notifications?status=open", undefined, 200)).data.items ?? [];
  ok("[best] Resolved leaves the open view", !open2.some((n) => String(n._id) === String(mine._id)));
  const resolved = (await req(admin, "GET", "/api/notifications?status=Resolved", undefined, 200)).data.items ?? [];
  const row = resolved.find((n) => String(n._id) === String(mine._id));
  ok("[best] …and records who resolved it", !!row?.acknowledged_by, JSON.stringify(row?.acknowledged_by));
}

// [worst] garbage status is refused, not stored.
if (mine) await req(admin, "POST", `/api/notifications/${mine._id}`, { status: "Deleted" }, 400);

// [worst] an alert not addressed to your role is untouchable even by ID.
const spoc = await login("spoc.jpr03@vidysea.com", "Vidysea@123");
if (spoc && mine) {
  const r = await req(spoc, "POST", `/api/notifications/${mine._id}`, { status: "Acknowledged" });
  ok("[worst] SPOC cannot act on an Admin-addressed alert by guessing its id", r.status === 403, `got ${r.status}`);
}

// [avg] scoping: a scoped user's inbox never carries another centre's location alert.
if (spoc) {
  const spocInbox = (await req(spoc, "GET", "/api/notifications?status=all", undefined, 200)).data.items ?? [];
  ok("[avg] scoped inbox has no rows for the fixture centre (out of scope)", !spocInbox.some((n) => String(n.location?._id ?? n.location) === String(loc._id)),
    `${spocInbox.length} rows`);
}

// [avg] the type filter reaches alerts that volume would otherwise bury.
const typed = (await req(admin, "GET", "/api/notifications?status=all&type=trainer_request_new", undefined, 200)).data.items ?? [];
ok("[avg] type filter returns only that type", typed.length > 0 && typed.every((n) => n.type === "trainer_request_new"), JSON.stringify([...new Set(typed.map((n) => n.type))]));

// [avg] count endpoint agrees with the list it summarizes (the bell badge's contract).
const openList = (await req(admin, "GET", "/api/notifications?status=open", undefined, 200)).data.items ?? [];
const openCount = (await req(admin, "GET", "/api/notifications?status=open&count=1", undefined, 200)).data.count;
ok("[avg] ?count=1 matches the list length (below the 500 cap)", openList.length === Math.min(openCount, 500), `count=${openCount} list=${openList.length}`);

finish();
