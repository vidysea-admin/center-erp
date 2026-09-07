// QA-1996 / QA-1997 / QA-2014 — the system must never be left with no Admin who can sign in.
//
// WHY THIS SUITE EXISTS, AND WHY IT RACES.
//
// The last-Admin guard was written, shipped, and then reported to Umesh as UNREACHABLE — twice —
// on the strength of a pin that could not produce the condition. That pin issued requests ONE AT A
// TIME, and one at a time the reasoning really does hold: removing an Admin requires Admin rights,
// a self-change is refused outright, and `requireUser` refuses an inactive caller, so the actor is
// always a live Admin and the target is therefore never the last one.
//
// A checker then reproduced the lockout 3 of 3 rounds by sending TWO requests at once. Two live
// Admins each removing the other both read "one other Admin still exists", both pass a
// countDocuments check, and both write. Zero Admins, and no way back in, because the Admin role
// cannot be granted from the rights screen — recovery took a direct collection write.
//
// "I could not make it happen" is not "it cannot happen". The difference was two requests.
//
// THE ASSERTION IS AN INVARIANT, NOT A TIMING. A pin that demanded a specific interleaving would be
// flaky, and a flaky pin gets deleted. What is asserted instead is the property that must hold
// however the two requests interleave: after the dust settles, at least one Admin can still sign
// in. That is true on the fixed code for every ordering, and it was false on the broken code.
import { requireLocalBase } from "./db-guard.mjs";
// This suite creates Admins and deactivates Admins. Pointed at a non-local address it would do both
// on production — QA-1966 is the row for the suite that shipped without this line.
const BASE = requireLocalBase("e2e-admin-floor", process.env.BASE_URL || "http://localhost:3000/erp");
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

const PW = "FloorPin@123";
const ROOT_EMAIL = "admin@vidysea.com";
const ROOT_PW = process.env.ADMIN_PASSWORD || "admin123";
const stamp = Date.now().toString(36);
let root = await login(ROOT_EMAIL, ROOT_PW);
ok("[precondition] the seed Admin can sign in", !!root, "no session");

// QA-2014: "can sign in" is `authorize()`'s definition (src/auth.ts:53-54) — it refuses only
// "Pending" and "Rejected". An account with NO approval_status signs in fine, and `scripts/seed.mjs`
// creates exactly such an Admin through the raw driver. An earlier version of this helper copied the
// guard's narrower `=== "Approved"` test, reported the seeded Admin as not existing, and that
// disagreement is what exposed QA-2014 in the product.
const isEffective = (u) => u.role === "Admin" && u.active !== false && !u.dropped
  && u.approval_status !== "Pending" && u.approval_status !== "Rejected";
const effectiveAdmins = async (cookie) => {
  const r = await req(cookie, "GET", "/api/users?limit=500");
  return (r.data?.items ?? []).filter(isEffective);
};

// ---------------------------------------------------------------- the fixture
// Two extra Admins, so the seed Admin is never the one at risk. If either fails to build, every
// assertion below is meaningless — so the fixture is asserted rather than assumed (QA-1214: a skip
// that looks like a pass is not a pass).
const mk = async (tag) => {
  const email = `zzfloor.${tag}.${stamp}@vidysea-test.local`;
  const r = await req(root, "POST", "/api/users", {
    name: `ZZ Floor ${tag} ${stamp}`, email, role: "Admin", password: PW, can_edit: true,
  });
  return { email, status: r.status, id: r.data?.item?._id };
};
const A = await mk("a");
const B = await mk("b");
ok("[precondition] two throwaway Admins were created", !!A.id && !!B.id, `a=${A.status} b=${B.status}`);

const sessA = A.id ? await login(A.email, PW) : null;
const sessB = B.id ? await login(B.email, PW) : null;
ok("[precondition] both throwaway Admins can actually sign in", !!sessA && !!sessB, `a=${!!sessA} b=${!!sessB}`);

const baseline = await effectiveAdmins(root);
ok("[precondition] at least three Admins can sign in before the race", baseline.length >= 3, `count=${baseline.length}`);

// Everything below needs both sessions; without them there is no race to run and saying so beats
// silently passing.
if (!sessA || !sessB) {
  ok("QA-1996: the race could be set up at all", false, "one of the throwaway Admin sessions is missing");
} else {
  // Park every OTHER Admin so A and B are the floor. NOTE: deactivating the seed Admin invalidates
  // ITS OWN session (QA-080, invalidateIdentity), so `root` is dead from here until we sign in again
  // — an earlier version of this suite kept using it and every restore call answered 401, which is
  // why its teardown "failed" while the product was fine.
  const parked = [];
  for (const u of baseline.filter((u) => ![String(A.id), String(B.id)].includes(String(u._id)))) {
    const r = await req(sessA, "PATCH", `/api/users/${u._id}`, { active: false });
    if (r.status === 200) parked.push(String(u._id));
  }
  root = null; // deliberately unusable: it may have just been switched off

  const floor = await effectiveAdmins(sessA);
  ok("[precondition] exactly the two throwaway Admins hold the floor",
    floor.length === 2 && floor.every((u) => [String(A.id), String(B.id)].includes(String(u._id))),
    `count=${floor.length} ids=${floor.map((u) => u.name).join(",")}`);

  if (floor.length === 2) {
    // ---- QA-1996: the deactivation race. Both requests are in flight before either finishes.
    const [ra, rb] = await Promise.all([
      req(sessA, "PATCH", `/api/users/${B.id}`, { active: false }),
      req(sessB, "PATCH", `/api/users/${A.id}`, { active: false }),
    ]);
    const left = await effectiveAdmins(sessA) ;
    const leftB = left.length ? left : await effectiveAdmins(sessB);
    ok("QA-1996: two Admins deactivating each other at the same instant NEVER leave zero Admins",
      leftB.length >= 1,
      `both answered ${ra.status}/${rb.status} and no Admin can sign in - the system is locked out with no way back`);
    ok("QA-1996: ...and at least one of the two racing requests is refused rather than both succeeding",
      ra.status >= 400 || rb.status >= 400, `got ${ra.status} and ${rb.status}`);

    // Put both back, using whichever session still works.
    for (const c of [sessA, sessB]) for (const id of [A.id, B.id]) await req(c, "PATCH", `/api/users/${id}`, { active: true });

    // ---- QA-1997: the FOURTH door. `{approval:"reject"}` sets approval_status AND active=false,
    // and was missing from the guard's clause list.
    const before = await effectiveAdmins(sessA);
    if (before.length >= 2) {
      const [rc, rd] = await Promise.all([
        req(sessA, "PATCH", `/api/users/${B.id}`, { approval: "reject" }),
        req(sessB, "PATCH", `/api/users/${A.id}`, { approval: "reject" }),
      ]);
      const after = await effectiveAdmins(sessA);
      const afterAny = after.length ? after : await effectiveAdmins(sessB);
      ok("QA-1997: the same race through the REJECT door also never leaves zero Admins",
        afterAny.length >= 1, `both answered ${rc.status}/${rd.status} and no Admin can sign in`);
    } else {
      ok("QA-1997: the reject-door race had two Admins to race", false,
        `count=${before.length} - this pin measured nothing`);
    }
  }

  // ---------------------------------------------------------------- restore
  // Bring the parked Admins back through whichever throwaway session still has rights, THEN sign in
  // as the seed Admin again and remove the throwaways. Leaving an inactive seed Admin behind would
  // break every later suite that logs in as one.
  for (const c of [sessA, sessB]) {
    for (const id of parked) await req(c, "PATCH", `/api/users/${id}`, { active: true, approval: "approve" });
  }
  root = await login(ROOT_EMAIL, ROOT_PW);
  ok("[teardown] the seed Admin can sign in again", !!root, "the seed Admin is still switched off");
  if (root) {
    for (const id of [A.id, B.id]) if (id) await req(root, "PATCH", `/api/users/${id}`, { drop: true });
    const final = await effectiveAdmins(root);
    ok("[teardown] the throwaway Admins are gone and the floor is intact",
      final.length >= 1 && !final.some((u) => String(u.email ?? "").startsWith("zzfloor.")),
      `count=${final.length} remaining=${final.map((u) => u.email).join(",")}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
