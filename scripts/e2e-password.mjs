// QA-1829a — "change my own password".
//
// PROVENANCE AND WHY IT IS ITS OWN FILE: this unit was built while a CONCURRENT session held
// `qa-1831` and was actively editing `scripts/e2e-roles.mjs` for its cycle 3. Adding these pins
// there would have been two sessions writing one file — the shared-surface collision CLAUDE.md
// spends a page on. A new suite costs one line in `run-e2e.mjs` and nothing else.
//
// WHAT MAKES THIS SUITE DIFFERENT FROM EVERY OTHER PASSWORD ASSERTION IN THE WALL: it does not ask
// whether the endpoint returned 200. It asks whether the CREDENTIAL ACTUALLY CHANGED, by logging in
// again — with the old password, which must now fail, and the new one, which must now work. An
// endpoint that returns 200 and hashes nothing satisfies every other shape of assertion, and this
// codebase has already shipped one report full of nulls that passed every structural pin around it
// (QA-1948). A credential route is exactly where that mistake would be most expensive.
import { requireLocalBase } from "./db-guard.mjs";
// QA-1966 (checker, cycle 1): this was the ONLY write-heavy HTTP suite in the wall with no BASE_URL
// guard. It creates a user and changes a password through whatever server BASE_URL names, so run
// directly against a non-local address it would have done both ON PRODUCTION - and QA-1096 already
// records that a direct single-suite run bypasses the runner guards that would otherwise catch it.
// The checker proved it by A/B: e2e-roles refused and sent nothing, this one ran 16/16 and wrote.
//
// I wrote this file thinking about what its assertions prove and not about where they would land.
// Thirteen sibling suites already had the line.
const BASE = requireLocalBase("e2e-password", process.env.BASE_URL || "http://localhost:3000/erp");
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

const ADMIN_PW = process.env.ADMIN_PASSWORD || "admin123";
const admin = await login("admin@vidysea.com", ADMIN_PW);
ok("[precondition] an Admin session exists to create the subject with", !!admin, "login failed");

// A THROWAWAY subject, never a seeded account. Changing a seeded password would leave every later
// suite in the wall logging in with a credential this file silently moved — the kind of neighbourly
// damage that shows up three suites later as an unrelated auth failure.
const stamp = Date.now().toString(36);
const EMAIL = `pwtest.${stamp}@vidysea-test.local`;
const PW1 = "InitialPw@123";
const PW2 = "ChangedPw@456";

const made = admin ? await req(admin, "POST", "/api/users", { name: `PW Test ${stamp}`, email: EMAIL, password: PW1, role: "Trainer" }) : { status: 0 };
ok("[precondition] a throwaway subject is created with a known password", made.status === 201 || made.status === 200, `got ${made.status}`);
const subjectId = made.data?.item?._id ?? made.data?._id;

// A TRAINER on purpose: the route must not be gated on `users.manage`, because the whole point is
// that every role owns their own password. A Trainer's only other doors are Home and Batches.
let sess = await login(EMAIL, PW1);
ok("QA-1829a [precondition] the subject can sign in with the password they were given", !!sess, "login failed");

if (sess) {
  // ---- the refusals first, so a later success cannot be explained by the route accepting anything
  const wrong = await req(sess, "POST", "/api/me/password", { current_password: "NotTheirPassword1", new_password: PW2 });
  ok("QA-1829a: a wrong current password is refused", wrong.status === 400, `got ${wrong.status}`);
  // ...and the refusal must not have changed anything. A route that 400s AFTER writing is a route
  // whose error message is the only thing that is honest.
  ok("QA-1829a: ...and the password is genuinely unchanged after that refusal, proven by logging in",
    !!(await login(EMAIL, PW1)), "the original password stopped working after a REFUSED change");

  const short = await req(sess, "POST", "/api/me/password", { current_password: PW1, new_password: "Ab1!" });
  ok("QA-1829a: a password under 8 characters is refused", short.status === 400, `got ${short.status}`);

  const same = await req(sess, "POST", "/api/me/password", { current_password: PW1, new_password: PW1 });
  ok("QA-1829a: re-setting the same password is refused", same.status === 400, `got ${same.status}`);

  const asEmail = await req(sess, "POST", "/api/me/password", { current_password: PW1, new_password: EMAIL });
  ok("QA-1829a: a password equal to the account's own email is refused", asEmail.status === 400, `got ${asEmail.status}`);

  // ---- and only now, the success
  const good = await req(sess, "POST", "/api/me/password", { current_password: PW1, new_password: PW2 });
  ok("QA-1829a: a Trainer changes their OWN password with no users.manage right", good.status === 200, `got ${good.status} ${JSON.stringify(good.data).slice(0, 120)}`);

  // THE TWO THAT MATTER. 200 proves nothing about a hash.
  ok("QA-1829a: the OLD password no longer works", !(await login(EMAIL, PW1)), "the old password still signs in");
  ok("QA-1829a: ...and the NEW password does", !!(await login(EMAIL, PW2)), "the new password does not sign in");
}

// ---- the guard this route exists BESIDE, which must still hold. Widening PRIV_FIELDS or carving a
// self-exception into PATCH /api/users/[id] would have been the smaller diff and would have
// re-opened the 2026-08-12 S0: a non-Admin with the grantable `users.manage` right rewriting an
// Admin's hash. This asserts the old door is still shut, so a future "simplification" that merges
// the two cannot pass quietly.
// QA-1969 (checker, cycle 1): these were bare `if`s. A pin inside an unasserted `if` does not FAIL
// when its precondition disappears - it silently stops existing, and the suite still reports green.
// That is the same family as an `.every()` over an empty set, which cost this branch three cycles
// on a different unit. The precondition is now itself an assertion.
const meRow = admin ? (await req(admin, "GET", "/api/users?limit=200")).data?.items?.find((u) => u.email === "admin@vidysea.com") : null;
ok("QA-1829a [precondition] the Admin's own row is readable, so the old-door pin below actually runs",
  !!meRow, "could not resolve admin@vidysea.com");
if (meRow) {
  const me = meRow;
  {
    const self = await req(admin, "PATCH", `/api/users/${me._id}`, { password: "SomethingElse1" });
    ok("QA-1829a: PATCH /api/users/[id] still refuses a self password edit, Admin included",
      self.status === 400, `got ${self.status}`);
    ok("QA-1829a: ...and the Admin password still works, so that refusal wrote nothing",
      !!(await login("admin@vidysea.com", ADMIN_PW)), "the admin password changed on a REFUSED request");
  }
}

// ---- unauthenticated
const anon = await fetch(BASE + "/api/me/password", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ current_password: "x", new_password: "Whatever12" }),
});
ok("QA-1829a: the door is closed to a caller with no session", anon.status === 401, `got ${anon.status}`);

// ---- rate limit: current_password is a guessing oracle against ONE named account, so the ceiling
// is keyed on the account, not only on the caller's IP.
{
  const s2 = await login(EMAIL, PW2) ?? await login(EMAIL, PW1);
  ok("QA-1829a [precondition] a session exists to exhaust the limiter with, so the pin below runs",
    !!s2, "no session");
  if (s2) {
    let sawLimit = false;
    for (let i = 0; i < 8; i++) {
      const r = await req(s2, "POST", "/api/me/password", { current_password: `wrong-${i}`, new_password: "Whatever12" });
      if (r.status === 429) { sawLimit = true; break; }
    }
    ok("QA-1829a: repeated wrong-current-password attempts are rate limited", sawLimit, "no 429 in 8 attempts");
  }
}


// ================= QA-1912a: the last Admin cannot be removed =================
// The ONLY assertion that proves this unit. A structural pin cannot: the guard is three boolean
// clauses and a count, and every wrong version of it still compiles, still reads sensibly, and still
// returns 200 on the happy path. It has to be driven into the state it defends.
//
// Reaching that state means briefly making a throwaway Admin the LAST one, which means deactivating
// the seeded admin. That is destructive, so three things bound it: this suite runs LAST in the wall,
// every step is reversed in a `finally`, and the reversal is then READ BACK and asserted. I fixed a
// cleanup-only-on-the-happy-path bug in this same file an hour ago (QA-1968); doing it again here
// with a bigger blast radius would be the same mistake with worse consequences.
if (admin && meRow) {
  const t1 = `zzadmin1.${stamp}@vidysea-test.local`;
  const t2 = `zzadmin2.${stamp}@vidysea-test.local`;
  const TPW = "AdminPw@12345";
  let a1 = null, a2 = null, sessT1 = null;
  let deactivated = [];

  try {
    a1 = (await req(admin, "POST", "/api/users", { name: "ZZ Admin One", email: t1, password: TPW, role: "Admin", can_edit: true })).data?.item?._id;
    a2 = (await req(admin, "POST", "/api/users", { name: "ZZ Admin Two", email: t2, password: TPW, role: "Admin", can_edit: true })).data?.item?._id;
    ok("QA-1912a [precondition] two throwaway Admins exist", !!a1 && !!a2, `${a1} ${a2}`);
    sessT1 = await login(t1, TPW);
    ok("QA-1912a [precondition] the first can sign in, so it can act as the surviving Admin", !!sessT1, "login failed");

    if (a1 && a2 && sessT1) {
      // While more than one Admin is alive, removal is ALLOWED. Asserted FIRST so a later refusal
      // cannot be explained by the route simply refusing everything - which is the shape a guard
      // written one clause too wide would have.
      const okDrop = await req(sessT1, "PATCH", `/api/users/${a2}`, { active: false });
      ok("QA-1912a: with another Admin alive, deactivating one is allowed", okDrop.status === 200, `got ${okDrop.status}`);
      if (okDrop.status === 200) deactivated.push(a2);

      // Now make T1 the only Admin who can sign in, by deactivating every OTHER active one.
      const all = (await req(sessT1, "GET", "/api/users?limit=500")).data?.items ?? [];
      for (const u of all) {
        if (u.role !== "Admin" || u.active === false || u.dropped) continue;
        if (String(u._id) === String(a1)) continue;
        const r = await req(sessT1, "PATCH", `/api/users/${u._id}`, { active: false });
        if (r.status === 200) deactivated.push(String(u._id));
      }
      const survivors = ((await req(sessT1, "GET", "/api/users?limit=500")).data?.items ?? [])
        .filter((u) => u.role === "Admin" && u.active !== false && !u.dropped);
      ok("QA-1912a [precondition] exactly one Admin can now sign in, so the guard has something to defend",
        survivors.length === 1 && String(survivors[0]._id) === String(a1),
        `${survivors.length} survivor(s): ${survivors.map((u) => u.email).join(",")}`);

      // THE THREE PATHS. Each writes separately in the route, so each is asserted separately - a
      // guard covering two of three is the exact failure this unit exists to prevent.
      for (const [label, body] of [
        ["deactivating them", { active: false }],
        ["demoting them to another role", { role: "Operations" }],
        ["dropping them", { drop: true }],
      ]) {
        // Driven by a DIFFERENT Admin session would be ideal, but there is no other Admin left -
        // that is the whole point of the state. T1 acts on T1, so the self-edit refusal (400) would
        // also fire; the pin therefore requires 409 specifically, not merely "an error".
        const r = await req(sessT1, "PATCH", `/api/users/${a1}`, body);
        ok(`QA-1912a: ${label} is refused when they are the last Admin who can sign in`,
          r.status === 409, `got ${r.status} ${JSON.stringify(r.data?.error ?? "").slice(0, 90)}`);
      }

      // ...and it is still true afterwards: a refusal that wrote half of itself is worse than none.
      const after = (await req(sessT1, "GET", `/api/users?limit=500`)).data?.items?.find((u) => String(u._id) === String(a1));
      ok("QA-1912a: ...and after all three refusals they are still an active Admin, read back",
        !!after && after.role === "Admin" && after.active !== false && !after.dropped,
        JSON.stringify(after ? { role: after.role, active: after.active, dropped: after.dropped } : null));
    }
  } finally {
    // Reverse everything, then PROVE it. An unasserted restore is how a suite leaves the next one a
    // world it cannot explain.
    if (sessT1) for (const id of deactivated) await req(sessT1, "PATCH", `/api/users/${id}`, { active: true }).catch(() => {});
    const restored = admin ? (await req(admin, "GET", "/api/users?limit=500")).data?.items ?? [] : [];
    const adminBack = restored.find((u) => u.email === "admin@vidysea.com");
    ok("QA-1912a cleanup: the seeded Admin is active again, read back from the server",
      !!adminBack && adminBack.active !== false, JSON.stringify(adminBack ? { active: adminBack.active } : null));
    if (admin) for (const id of [a1, a2]) if (id) await req(admin, "PATCH", `/api/users/${id}`, { active: false }).catch(() => {});
    const leftovers = ((await req(admin, "GET", "/api/users?limit=500")).data?.items ?? [])
      .filter((u) => (u.email === t1 || u.email === t2) && u.active !== false);
    ok("QA-1912a cleanup: both throwaway Admins are deactivated", leftovers.length === 0,
      leftovers.map((u) => u.email).join(","));
  }
}

// ---- QA-1970 (checker, cycle 1): TWO of nine mutants survived, and both were the calls whose
// comments make the biggest claims - the audit write and invalidateIdentity. The second is now
// honestly described as a no-op here rather than pinned; this pins the first, which IS load-bearing.
// It also pins the thing nobody had asserted at all: that a credential route never writes a
// credential into the trail it leaves behind.
if (admin && subjectId) {
  const trail = await req(admin, "GET", `/api/audit/User/${subjectId}`);
  const rows = trail.data?.items ?? trail.data?.rows ?? [];
  ok("QA-1970 [precondition] the audit trail for the subject is readable, so the pins below run",
    trail.status === 200 && Array.isArray(rows), `got ${trail.status}`);
  ok("QA-1970: the change is recorded as a PASSWORD change, not the generic updated the Admin path writes",
    rows.some((r) => r.field === "password"),
    JSON.stringify(rows.map((r) => r.field).slice(0, 6)));
  // Neither the old nor the new password may appear ANYWHERE in the trail - not in a value, not in
  // a summary, not inside a payload object.
  const blob = JSON.stringify(trail.data ?? {});
  ok("QA-1970: ...and the trail carries neither the old password nor the new one",
    !blob.includes(PW1) && !blob.includes(PW2),
    blob.includes(PW1) ? "the OLD password is in the audit trail" : "the NEW password is in the audit trail");
}

// ---- tidy up: the subject is deactivated, never left able to sign in.
// QA-1968 (checker, cycle 1): this ran only on the happy path. An abort anywhere above it - a
// thrown fetch, a killed run - stranded an ACTIVE login with a known password. The account is a
// throwaway, but "throwaway" describes intent, not state, and the state is what can sign in.
async function retireSubject() {
  if (!admin || !subjectId) return;
  const off = await req(admin, "PATCH", `/api/users/${subjectId}`, { active: false });
  ok("cleanup: the throwaway subject is deactivated", off.status === 200, `got ${off.status}`);
}
process.on("uncaughtException", async (e) => { console.log("ABORTING: " + e?.message); await retireSubject().catch(() => {}); process.exit(1); });
process.on("unhandledRejection", async (e) => { console.log("ABORTING: " + e); await retireSubject().catch(() => {}); process.exit(1); });
await retireSubject();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
