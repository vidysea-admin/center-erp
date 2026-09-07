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
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";
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

  // ---------------------------------------------------------------- QA-2018 / QA-2014
  // THE PREVIOUS PIN FOR QA-2014 COULD NOT FAIL, AND A CHECKER MEASURED THAT: restoring the
  // pre-QA-2014 route and rebuilding still gave 10 passed / 0 failed. The reason is subtle and
  // worth writing down — every account this suite touches is created or changed through the API,
  // and a Mongoose `save()` writes `approval_status` to its schema default. So the very population
  // the bug is about (an Admin with NO approval_status, which is what `scripts/seed.mjs` creates
  // through the raw driver) was being destroyed by the fixture before the assertion ran.
  //
  // WHICH DIRECTION ACTUALLY DISTINGUISHES THE TWO PREDICATES. Not the removal being allowed —
  // both predicates allow that. The narrow one REFUSES A LEGITIMATE REMOVAL: with a raw-driver
  // Admin R (no approval_status, signs in fine) and a normal Admin A as the only two, R removing A
  // must SUCCEED, because R is still standing. Under `approval_status: "Approved"` the guard cannot
  // see R, counts zero others, and answers 409 with a live Admin sitting right there.
  //
  // That is also the correction to something this unit published: the -295 note said QA-2014 let
  // the last Admin be removed by an ordinary single request. On the build that shipped it does not
  // — the post-write check counted with the same narrow predicate and undid the write. The defect
  // is real; its consequence on the shipped build is over-refusal, not removal.
  {
    const dbUrl = process.env.MONGODB_URL;
    const dbName = process.env.MONGODB_DB;
    if (!dbUrl || !dbName) {
      ok("QA-2014: the raw-driver fixture had a database to write to", false,
        "MONGODB_URL/MONGODB_DB not set - this pin measured nothing");
    } else {
      const client = new MongoClient(dbUrl);
      let R = null;
      try {
        await client.connect();
        const users = client.db(dbName).collection("users");
        const email = `zzraw.${stamp}@vidysea-test.local`;
        // Inserted the way seed.mjs inserts the very first Admin: raw driver, so NO Mongoose
        // default applies and `approval_status` is genuinely absent.
        const ins = await users.insertOne({
          name: `ZZ Raw ${stamp}`, email, password_hash: await bcrypt.hash(PW, 10), role: "Admin",
          location_scope: [], can_edit: true, active: true, extra_permissions: [],
          createdAt: new Date(), updatedAt: new Date(),
        });
        R = String(ins.insertedId);
        const back = await users.findOne({ _id: ins.insertedId });
        ok("QA-2014 [fixture] the raw-driver Admin genuinely has NO approval_status",
          back && back.approval_status === undefined, `approval_status=${JSON.stringify(back?.approval_status)}`);

        const sessR = await login(email, PW);
        ok("QA-2014: an Admin with no approval_status CAN sign in - which is why the guard must count them",
          !!sessR, "authorize() refuses only Pending and Rejected, so this must succeed");

        if (sessR) {
          // Make R and A the only two who can sign in.
          const all = await effectiveAdmins(sessR);
          for (const u of all.filter((u) => ![R, String(A.id)].includes(String(u._id)))) {
            await req(sessR, "PATCH", `/api/users/${u._id}`, { active: false });
          }
          const two = await effectiveAdmins(sessR);
          ok("QA-2014 [precondition] exactly the raw-driver Admin and one normal Admin hold the floor",
            two.length === 2, `count=${two.length}`);

          if (two.length === 2) {
            const r = await req(sessR, "PATCH", `/api/users/${A.id}`, { active: false });
            ok("QA-2014: the raw-driver Admin COUNTS - removing the other Admin is allowed, because R is still standing",
              r.status === 200,
              `got ${r.status} - a 409 here means the guard cannot see an Admin whose approval_status is absent, and is refusing a legitimate change`);
            await req(sessR, "PATCH", `/api/users/${A.id}`, { active: true });
          }
          // hand the floor back before this block ends
          for (const id of parked) await req(sessR, "PATCH", `/api/users/${id}`, { active: true, approval: "approve" });
        }
      } catch (e) {
        ok("QA-2014: the raw-driver fixture ran without error", false, String(e && e.message || e));
      } finally {
        // The raw row never went through the API, so it is removed the same way it was made.
        try { if (R) await client.db(dbName).collection("users").deleteOne({ _id: (await import("mongodb")).ObjectId.createFromHexString(R) }); } catch {}
        try { await client.close(); } catch {}
      }
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
