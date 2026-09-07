// QA-1996 / QA-1997 — the system must never be left with no Admin who can sign in.
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
// however the two requests interleave: **after the dust settles, at least one Admin can still sign
// in.** That is true on the fixed code for every ordering, and it was false on the broken code.
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
const stamp = Date.now().toString(36);
const root = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
ok("[precondition] the seed Admin can sign in", !!root, "no session");

const effectiveAdmins = async () => {
  const users = (await req(root, "GET", "/api/users?limit=500")).data?.items ?? [];
  return users.filter((u) => u.role === "Admin" && u.active !== false && !u.dropped && u.approval_status === "Approved");
};

// ---------------------------------------------------------------- the fixture
// Two extra Admins, so the seed Admin is never the one at risk and the wall's other suites keep
// the account they expect. If either fails to build, every assertion below is meaningless — so the
// fixture is asserted rather than assumed (QA-1214: a skip that looks like a pass is not a pass).
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

// They must be able to sign in, or a "race" between two sessions is really no race at all and the
// pin would pass for the wrong reason.
const sessA = A.id ? await login(A.email, PW) : null;
const sessB = B.id ? await login(B.email, PW) : null;
ok("[precondition] both throwaway Admins can actually sign in", !!sessA && !!sessB, `a=${!!sessA} b=${!!sessB}`);

const baselineCount = (await effectiveAdmins()).length;
ok("[precondition] at least three Admins can sign in before the race", baselineCount >= 3, `count=${baselineCount}`);

// ---------------------------------------------------------------- QA-1996: the deactivation race
// Reduce to exactly the dangerous shape: A and B are the only two effective Admins, and each tries
// to stop the other in the same instant. The seed Admin steps aside first so the floor really is
// these two — done through the same door everything else uses, and undone at the end.
let rootWasParked = false;
if (sessA && sessB) {
  const meRoot = (await req(root, "GET", "/api/me")).data?.user ?? {};
  const rootId = String(meRoot.id ?? meRoot._id ?? "");
  const others = (await effectiveAdmins()).filter((u) => ![String(A.id), String(B.id)].includes(String(u._id)));
  // Park every OTHER Admin (normally just the seed one) so A and B are the floor.
  for (const u of others) {
    const r = await req(sessA, "PATCH", `/api/users/${u._id}`, { active: false });
    if (r.status === 200 && String(u._id) === rootId) rootWasParked = true;
  }
  const now = await effectiveAdmins();
  ok("[precondition] exactly the two throwaway Admins hold the floor",
    now.length === 2 && now.every((u) => [String(A.id), String(B.id)].includes(String(u._id))),
    `count=${now.length} ids=${now.map((u) => u.name).join(",")}`);

  if (now.length === 2) {
    // THE RACE. Both requests are in flight before either can have finished.
    const [ra, rb] = await Promise.all([
      req(sessA, "PATCH", `/api/users/${B.id}`, { active: false }),
      req(sessB, "PATCH", `/api/users/${A.id}`, { active: false }),
    ]);
    const left = await effectiveAdmins();
    ok("QA-1996: two Admins deactivating each other at the same instant NEVER leave zero Admins",
      left.length >= 1,
      `both answered ${ra.status}/${rb.status} and ${left.length} Admins can sign in - the system is locked out with no way back`);
    ok("QA-1996: ...and at least one of the two racing requests is refused rather than both succeeding",
      ra.status >= 400 || rb.status >= 400, `got ${ra.status} and ${rb.status}`);

    // put both back for the next block, whichever way the race fell
    for (const id of [A.id, B.id]) await req(root, "PATCH", `/api/users/${id}`, { active: true });
  }

  // ------------------------------------------------------------ QA-1997: the FOURTH door
  // `{approval:"reject"}` sets approval_status AND active=false, and was missing from the guard's
  // clause list. The guard's own comment said "a guard that covers two of three is the shape this
  // repo keeps paying for" - it shipped covering three of four.
  const before = await effectiveAdmins();
  if (before.length >= 2) {
    const [ra, rb] = await Promise.all([
      req(sessA, "PATCH", `/api/users/${B.id}`, { approval: "reject" }),
      req(sessB, "PATCH", `/api/users/${A.id}`, { approval: "reject" }),
    ]);
    const left = await effectiveAdmins();
    ok("QA-1997: the same race through the REJECT door also never leaves zero Admins",
      left.length >= 1,
      `both answered ${ra.status}/${rb.status} and ${left.length} Admins can sign in`);
  } else {
    ok("QA-1997: the reject-door race had two Admins to race", false, `count=${before.length} - this pin measured nothing`);
  }
}

// ---------------------------------------------------------------- restore
// Leave the wall exactly as we found it: the seed Admin back on, the throwaways gone. A suite that
// quietly leaves an inactive Admin behind breaks every later suite that logs in as one.
for (const u of await (async () => ((await req(root, "GET", "/api/users?limit=500")).data?.items ?? []))()) {
  if (u.role === "Admin" && u.active === false && !String(u.email ?? "").startsWith("zzfloor.")) {
    await req(root, "PATCH", `/api/users/${u._id}`, { active: true });
  }
}
for (const id of [A.id, B.id]) if (id) await req(root, "PATCH", `/api/users/${id}`, { drop: true });

const finalAdmins = await effectiveAdmins();
ok("[teardown] the seed Admin is signed-in-able again and the throwaways are gone",
  finalAdmins.length >= 1 && !finalAdmins.some((u) => String(u.email ?? "").startsWith("zzfloor.")),
  `count=${finalAdmins.length} rootParked=${rootWasParked}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
