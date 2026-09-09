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
import { MongoClient } from "mongodb";
import crypto from "node:crypto";
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
async function req(cookie, method, p, body, extraHeaders = {}) {
  const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", cookie, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
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

      // THE DOORS, and what this pin established - which is NOT what it was written to establish,
      // and NOT what the version of this comment before QA-2051 concluded either.
      //
      // It was written to prove the new 409 guard fires. It failed three times with the
      // PRE-EXISTING self-edit 400, and that failure was read as proof the guard was UNREACHABLE.
      // The enumeration ran: removing an Admin requires `changingPriv`, which 403s a non-Admin
      // actor; `requireUser` (authz.ts:93) refuses an inactive or unapproved caller, so the actor is
      // always a live Admin. Therefore either the actor is SOMEBODY ELSE - in which case they are
      // themselves another active Admin and the target is not the last - or the actor is the target,
      // and the self-edit refusal fires first. "There is no third case."
      //
      // THERE IS A THIRD CASE: TWO REQUESTS. Two live Admins each removing the other at the same
      // instant both read "one other Admin still exists", both pass, both write. A checker
      // reproduced zero effective Admins 3 of 3 rounds and then could not sign in to its own copy.
      // Every clause of the enumeration above is true of ONE request at a time; the conclusion is
      // false anyway. That is why it is quoted here rather than deleted.
      //
      // So BOTH locks hold the floor and either may answer: the self-edit refusal with 400, the
      // last-Admin floor with 409. Umesh was told twice that the lockout was reachable, then twice
      // that it was not; the second pair was the wrong one, and this comment was part of how that
      // wrong answer kept being repeated - it survived QA-2016, QA-2017 and QA-2019, which fixed
      // the same story in the source comment, the runbook and the public release note.
      //
      // The pin therefore asserts the REAL invariant - the floor is one, whatever refusal enforces
      // it - and separately records WHICH refusal is doing the work today. If a later change relaxes
      // the self-edit rule, the second assertion flips to 409 and the first still holds, which is
      // exactly the behaviour the guard exists for.
      const refusals = [];
      for (const [label, body] of [
        ["deactivating", { active: false }],
        ["demoting", { role: "Operations" }],
        ["dropping", { drop: true }],
      ]) {
        const r = await req(sessT1, "PATCH", `/api/users/${a1}`, body);
        refusals.push([label, r.status]);
        ok(`QA-1912a: ${label} the last Admin who can sign in is REFUSED`,
          r.status === 400 || r.status === 409,
          `got ${r.status} ${JSON.stringify(r.data?.error ?? "").slice(0, 90)}`);
      }
      // QA-2051 — THIS ASSERTION USED TO STATE A DISPROVED CLAIM, AND IT STATED IT EXECUTABLY.
      //
      // It read: "today it is the self-edit rule doing that work, not the last-Admin guard - the
      // guard is defence in depth for a route that does not yet exist", and it enforced that by
      // requiring EVERY refusal to be 400. A 409 - the last-Admin guard actually firing - would
      // have FAILED this pin. So the suite asserted that the guard does not work, and printed it
      // green.
      //
      // Two costs, and the second is the one that matters. Deleting the guard entirely left this
      // pin passing. And this was the FOURTH place the disproved "there is no third case" story
      // survived after QA-2016 fixed the comment, QA-2017 the runbook and QA-2019 the release note
      // - the only one of the four that a machine reads. A wrong sentence in a comment misleads the
      // next person; a wrong sentence in an assertion enforces itself.
      //
      // It was also reported before it was fixed: the qa-1912a cycle-1 checker named this exact
      // block, and the maker relayed the finding to a peer session and then did not act on it.
      //
      // What is true, and what this now measures: BOTH locks are load-bearing and either may answer.
      // The self-edit rule (PRIV_FIELDS, users/[id]/route.ts:31) refuses with 400. The last-Admin
      // floor refuses with 409. Which one speaks depends on the door and on whether another Admin
      // is standing - so the assertion is that the change is REFUSED, and the split is recorded
      // rather than demanded.
      ok("QA-1912a/QA-2051: every door is refused, by one lock or the other - and it is NOT asserted which",
        refusals.every(([, st]) => st === 400 || st === 409), JSON.stringify(refusals));
      console.log(`      NOTE  which lock answered: ${JSON.stringify(refusals)} (400 = self-edit rule, 409 = last-Admin floor)`);

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


// ==========================================================================================
// QA-1829b — FORGOT PASSWORD. The half of QA-1829 that needs mail.
//
// WHY THE SUITE CANNOT JUST READ THE CODE, and why that is correct. QA-142 keeps the code out of
// the mail LOG on purpose - the Admin mail panel must not become a list of live reset codes - so
// `GET /api/test-email` shows only the masked subject. There is no way for a test to learn the
// code, and building one (returning it in the response under a test flag, say) would be a door
// that exists in production and is one env var away from being open.
//
// So the fixture SETS the challenge instead of reading it: the request path is asserted on its own
// evidence (a MailLog row exists, addressed to the right person, with no digits in the logged
// subject), and then the token's `otp_hash` is replaced with the hash of a code this file chose.
// Everything security-critical after that - single use, attempt burn, expiry, the password floor,
// and that the new password actually works at the login door - is driven for real.
{
  const dbUrl = process.env.MONGODB_URL, dbName = process.env.MONGODB_DB;
  const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
  const CODE = "424242";
  const fpEmail = `fp.${stamp}@vidysea-test.local`;
  const FP1 = "FirstPass@123", FP2 = "SecondPass@456";

  if (!dbUrl || !dbName) {
    ok("QA-1829b: the suite had a database to seed the challenge into", false,
      "MONGODB_URL/MONGODB_DB not set - this block measured nothing");
  } else {
    const client = new MongoClient(dbUrl);
    try {
      await client.connect();
      const db = client.db(dbName);
      // "" not null: a null header value is not something fetch has to accept, and this door is
      // public - it takes no cookie at all.
      const post = (b) => req("", "POST", "/api/public/forgot-password", b);

      // ---- THE PAGE MUST BE REACHABLE WITHOUT A SESSION. src/proxy.ts (Next 16's middleware) is
      // an ALLOWLIST, and a route not on it redirects 307 to /login - which for a
      // forgot-password screen means the only person who needs it is the only person who cannot
      // open it. That is exactly what shipped in this unit's first build, and this pin is why it
      // did not survive. `redirect: "manual"` so the 307 is seen instead of being followed into a
      // 200 that looks fine.
      const pageRes = await fetch(`${BASE}/forgot`, { redirect: "manual" });
      ok("QA-1829b: /forgot opens WITHOUT a session - it is on the proxy allowlist",
        pageRes.status === 200, `got ${pageRes.status}${pageRes.headers.get("location") ? " -> " + pageRes.headers.get("location") : ""}`);
      const pageHtml = pageRes.status === 200 ? await pageRes.text() : "";
      ok("QA-1829b: ...and it renders the reset screen rather than something else",
        /Reset your password/.test(pageHtml), `${pageHtml.length} bytes`);
      ok("QA-1829b: ...with NO signed-in shell chrome on it (it sits outside the (app) group)",
        !/Sign out/.test(pageHtml), "the app shell rendered to a logged-out visitor");

      const made = await req(admin, "POST", "/api/users", { name: `FP ${stamp}`, email: fpEmail, password: FP1, role: "Trainer" });
      ok("QA-1829b [precondition] a subject account exists", made.status === 201, `got ${made.status}`);
      const subjectId = made.data?.item?._id;

      // ---- QA-2111: THE PATH A PERSON ACTUALLY TAKES, and the one every other pin here missed.
      //
      // Nineteen assertions passed over a feature that was INOPERABLE through its own page: the
      // request response carried no `token`, so /forgot set token = "" and every verify after it
      // looked up the empty string. They passed because the fixture below reads the token out of
      // the DATABASE — so the suite exercised the API and never the path a user takes.
      //
      // This block takes the token ONLY from the response, the way the page does, and drives the
      // whole flow with it. If the response ever stops carrying a usable token again, this fails
      // and nothing else here will.
      {
        const email2 = `fp2.${stamp}@vidysea-test.local`;
        const P1 = "PageFlow@111", P2 = "PageFlow@222";
        const mk2 = await req(admin, "POST", "/api/users", { name: `FP2 ${stamp}`, email: email2, password: P1, role: "Trainer" });
        ok("QA-2111 [precondition] a second subject account exists", mk2.status === 201, `got ${mk2.status}`);

        const asked = await post({ action: "request", email: email2 });
        ok("QA-2111: the request response CARRIES a token - the page has nothing else to use",
          typeof asked.data?.token === "string" && asked.data.token.length >= 16,
          `token=${JSON.stringify(asked.data?.token)} - /forgot does setToken((prev) => d.token ?? prev) and then verifies with it. (This string said `?? ""` until QA-2275; that stopped being true at cycle 5, when the page was changed to KEEP a held token rather than replace it, and a failure message that describes code which no longer exists sends its reader to the wrong place.)`);

        // ---- QA-2246 (S1) — THE COOLDOWN BRANCH MUST NEVER HAND BACK THE LIVE TOKEN ----
        // A cycle-3 fix returned the address's LIVE challenge token to whoever asked inside the
        // per-address cooldown. `reset` authenticates on the token STRING ALONE, so once the
        // victim entered their own mailed code and promoted that token, a stranger holding the
        // same string could set the password. It never reached production, and the reason it
        // never reached production was a checker probing both builds - not this suite, which was
        // green across the vulnerable build.
        //
        // So this pin exists to make the NEXT one impossible to ship silently. `asked` above just
        // created a live challenge for email2, which puts us inside the 60s cooldown for that
        // address. A second request - from a DIFFERENT client key, which is the attacker's
        // position - must not receive the token that `asked` holds.
        //
        // The x-forwarded-for is not decoration: without it this second request shares the per-IP
        // budget with the first, and a 429 would make the pin pass for a reason that has nothing
        // to do with the property (the QA-2160 lesson, one block down).
        const stranger = await req("", "POST", "/api/public/forgot-password",
          { action: "request", email: email2 }, { "x-forwarded-for": "198.51.100.7" });
        ok("QA-2246 [precondition] the stranger's in-cooldown request is answered, not rate-limited",
          stranger.status === 200,
          `got ${stranger.status} - a 429 here means this pin measured the per-IP queue, not the door`);
        ok("QA-2246 (S1): a stranger asking inside the cooldown does NOT receive the victim's live token",
          stranger.data?.token !== asked.data?.token,
          `stranger token=${JSON.stringify(stranger.data?.token)} vs live token=${JSON.stringify(asked.data?.token)} - identical means the account-takeover regression is back`);

        // QA-2251 — THE COOLDOWN BRANCH RETURNS NO `token` KEY AT ALL, and that is the property
        // the page's rule depends on: it keeps what it holds ONLY when the key is absent, and
        // replaces whenever one arrives. A decoy here would be indistinguishable from a real
        // handle to the page, which is what made the first version of that fix never replace.
        ok("QA-2251: ...and the cooldown response carries NO token key, so the page can tell keep from replace",
          stranger.data !== undefined && !("token" in stranger.data),
          `cooldown response keys: ${JSON.stringify(Object.keys(stranger.data ?? {}))} - a token here is either the S1 or a decoy the page cannot distinguish from a live handle`);

        // Whatever it returned, it must correspond to no stored row. Checked against the database
        // rather than inferred from the string, because "different" and "useless" are two claims
        // and only the second is the security property.
        const strangerRow = stranger.data?.token
          ? await db.collection("publictokens").findOne({ token: stranger.data.token })
          : null;
        ok("QA-2246 (S1): ...and nothing it returned corresponds to a stored challenge",
          strangerRow === null,
          `a row exists for the token handed to the stranger: ${JSON.stringify(strangerRow && { email: strangerRow.email, otp_verified: strangerRow.otp_verified })}`);

        // QA-2251 — AND A REQUEST FOR A DIFFERENT ADDRESS MUST STILL CARRY ONE. This is the other
        // half, and it is the half the first fix broke: a person who mistypes their address, or
        // who burns a challenge and asks for a new code exactly as the screen advises, must get a
        // token that REPLACES the dead one. Its own client key, so the per-IP budget cannot make
        // this pass for the wrong reason.
        const retyped = await req("", "POST", "/api/public/forgot-password",
          { action: "request", email: `typo.${stamp}@vidysea-test.local` }, { "x-forwarded-for": "198.51.100.9" });
        ok("QA-2251 [precondition] the different-address request is answered, not rate-limited",
          retyped.status === 200, `got ${retyped.status}`);
        ok("QA-2251: a request for a DIFFERENT address returns a token, so the page replaces the dead one",
          typeof retyped.data?.token === "string" && retyped.data.token.length >= 16,
          `token=${JSON.stringify(retyped.data?.token)} - absent here means a mistyped address strands the person, which is QA-2201 rebuilt out of its own fix`);

        // ---- QA-2260 — THE KEEP JOURNEY, END TO END, WHICH THE PREVIOUS PIN NAMED BUT DID NOT
        // REACH. Its comment described two cases and its assertion covered only the mistype one:
        // it requested a FRESH address, never the SAME address inside the cooldown. So the branch
        // that keeps a held token had no assertion at all, and QA-2259 (the keep-branch being
        // unreachable from the page) shipped underneath a green suite.
        //
        // This drives what a person actually does: ask, don't see the mail, ask AGAIN for the same
        // address, then enter the code from the FIRST mail. The token they hold must still work.
        const heldRow = await db.collection("publictokens").findOne({ token: asked.data?.token });
        ok("QA-2260 [precondition] the person's own challenge row exists to drive the keep journey",
          !!heldRow, `no row for the token the request returned: ${JSON.stringify(asked.data?.token)}`);
        if (heldRow) {
          // Arm it with a code this file knows - the mailed code is unrecoverable by design
          // (QA-142: the logged subject is masked), which is the same reason `arm()` exists below.
          await db.collection("publictokens").updateOne({ _id: heldRow._id },
            { $set: { otp_hash: crypto.createHash("sha256").update(CODE).digest("hex"), otp_attempts: 0, otp_verified: false, otp_expires_at: new Date(Date.now() + 10 * 60_000) } });

          const again = await req("", "POST", "/api/public/forgot-password",
            { action: "request", email: email2 }, { "x-forwarded-for": "198.51.100.11" });
          ok("QA-2260 [precondition] the in-cooldown resend for the SAME address is answered, not rate-limited",
            again.status === 200, `got ${again.status}`);
          ok("QA-2260: an in-cooldown resend for the SAME address returns no token, so the page keeps what it holds",
            again.data !== undefined && !("token" in again.data),
            `keys: ${JSON.stringify(Object.keys(again.data ?? {}))}`);
          ok("QA-2260: ...and it says so honestly - it does NOT claim a fresh code was sent",
            !/on its way/i.test(String(again.data?.message ?? "")),
            `message: ${JSON.stringify(again.data?.message)} - promising a mail that the cooldown refused to send is QA-2259`);

          // THE ASSERTION THAT MATTERS: the token the person was holding before the resend must
          // still verify. If the resend burned or replaced the challenge, this goes red - which is
          // exactly the journey that stranded people through four cycles of this unit.
          const heldVerify = await req("", "POST", "/api/public/forgot-password",
            { action: "verify", token: asked.data?.token, code: CODE });
          ok("QA-2260: the token the person HELD still verifies after an in-cooldown resend",
            heldVerify.status === 200,
            `got ${heldVerify.status} - the held token stopped working after asking again, which is QA-2201 by its fourth route`);

          // QA-2290: THE OTHER SIDE OF THE SAME MINUTE, and the reason this pin exists is a note
          // rather than a bug. -299's public note said "asking again does not cancel a code you
          // are already holding" - true INSIDE the cooldown, which is the only case anyone had
          // measured, and false outside it: the request path runs
          // `updateMany({active:true},{active:false})` before minting, deliberately, so that one
          // address never has two live codes in two mails. The sentence was written from the
          // measured case with its boundary deleted, which is QA-2088's shape exactly and the
          // fifth such clause in seven notes.
          //
          // THE FIRST VERSION OF THIS PIN COULD NOT HAVE PASSED, and it was caught by reading the
          // mechanism before running it. It aged the challenge's `createdAt` to escape the
          // cooldown - but `emailChallengeGate` (rate-limit.ts:88) reads an IN-MEMORY buckets Map,
          // not the document, so the second request would have been refused as in-cooldown and the
          // old challenge would still be active: red on a product behaving exactly as described.
          // That is the mirror of this repo's most-filed defect, produced here inside the pin
          // written to close a note that had the same shape.
          //
          // So pin the MECHANISM the note describes, without waiting 60 s for a wall-time cooldown
          // that cannot be advanced from outside the process: mint a live challenge for a FRESH
          // address directly (the suite already does this), then make ONE ordinary request for that
          // address. No cooldown bucket exists for it, so the request proceeds - and if the
          // "one live code per address" rule holds, the minted challenge is dead afterwards.
          // DISCLOSED LIMIT: this exercises the burn, not two API requests a minute apart.
          const burnEmail = "fp-burn." + stamp + "@vidysea-test.local";
          const burnToken = crypto.randomBytes(16).toString("hex");
          await db.collection("users").insertOne({
            name: "FP Burn " + stamp, email: burnEmail, role: "Operations", active: true,
            approval_status: "Approved", createdAt: new Date(), updatedAt: new Date(),
          });
          await db.collection("publictokens").insertOne({
            token: burnToken, purpose: "password_reset", email: burnEmail, active: true,
            otp_hash: crypto.createHash("sha256").update(CODE).digest("hex"), otp_attempts: 0, otp_verified: false,
            createdAt: new Date(), updatedAt: new Date(),
          });
          const burnAsk = await req("", "POST", "/api/public/forgot-password", { action: "request", email: burnEmail });
          ok("QA-2290 [precondition] the request for a never-asked address was answered, not rate-limited",
            burnAsk.status === 200, `got ${burnAsk.status} - a 429 here would make the assertion below vacuous`);
          const burnedRow = await db.collection("publictokens").findOne({ token: burnToken });
          ok("QA-2290: a fresh request REPLACES any live code for that address - the public note must say where that starts",
            burnedRow?.active === false,
            `pre-existing challenge active=${JSON.stringify(burnedRow?.active)} - if this stays true the product no longer burns the old code and -300's note is the wrong one`);
          await db.collection("users").deleteOne({ email: burnEmail });
        }

        // The victim's own challenge must be untouched by the stranger's request - the fix must
        // not have closed the hole by destroying the thing it was protecting.
        const victimRow = await db.collection("publictokens").findOne({ token: asked.data?.token });
        ok("QA-2246: the victim's live challenge is still active after the stranger asked",
          !!victimRow && victimRow.active === true,
          `victim row: ${JSON.stringify(victimRow && { active: victimRow.active, email: victimRow.email })}`);
        // An unknown address must ALSO get one, or the token's presence is the enumeration tell
        // this endpoint refuses to give.
        const decoy = await post({ action: "request", email: `nobody2.${stamp}@vidysea-test.local` });
        ok("QA-2111: ...and an UNKNOWN address gets a token too, so its presence tells nothing",
          typeof decoy.data?.token === "string" && decoy.data.token.length >= 16,
          `token=${JSON.stringify(decoy.data?.token)}`);
        ok("QA-2111: ...and the decoy token verifies to the SAME generic refusal, not a different one",
          (await post({ action: "verify", token: decoy.data?.token, code: "123456" })).status === 400,
          "an unknown address's token answered differently from a wrong code");

        // Drive the real flow with ONLY what the response gave us. The code still has to come from
        // the challenge - it is never in the response, and that is QA-142 working.
        if (asked.data?.token) {
          await db.collection("publictokens").updateOne({ token: asked.data.token }, { $set: { otp_hash: sha(CODE), otp_attempts: 0 } });
          const v = await post({ action: "verify", token: asked.data.token, code: CODE });
          ok("QA-2111: the response token VERIFIES - i.e. it is the real challenge, not a decoy",
            v.status === 200, `got ${v.status} ${JSON.stringify(v.data?.error ?? "")}`);
          const r = await post({ action: "reset", token: asked.data.token, password: P2 });
          ok("QA-2111: ...and the reset completes on it", r.status === 200, `got ${r.status}`);
          ok("QA-2111: ...and the account signs in with the password set through the PAGE's own path",
            !!(await login(email2, P2)), "the end-to-end path a person takes does not work");
        }
        if (mk2.data?.item?._id) await req(admin, "PATCH", `/api/users/${mk2.data.item._id}`, { drop: true });
      }

      // ---- ANTI-ENUMERATION. The two answers must be INDISTINGUISHABLE, because this door is
      // public and a difference between them is a free list of who works here.
      const known = await post({ action: "request", email: fpEmail });
      const unknown = await post({ action: "request", email: `nobody.${stamp}@vidysea-test.local` });
      ok("QA-1829b: a real and an unknown address get the SAME status",
        known.status === 200 && unknown.status === 200, `known=${known.status} unknown=${unknown.status}`);
      ok("QA-1829b: ...and the SAME message, word for word",
        String(known.data?.message ?? "") === String(unknown.data?.message ?? "") && !!known.data?.message,
        JSON.stringify({ known: known.data?.message, unknown: unknown.data?.message }));

      // ---- THE MAIL. Asserted on the log row, never on delivery (mail is suppressed outside
      // MONGODB_DB=center_erp, so a delivery assertion could never run here).
      const logs = (await req(admin, "GET", "/api/test-email")).data?.log ?? [];
      const row = logs.find((l) => l.to === fpEmail);
      ok("QA-1829b: the request produced a MailLog row addressed to the account holder", !!row,
        `${logs.length} rows, none to ${fpEmail}`);
      ok("QA-1829b: ...and the LOGGED subject carries NO code - the mail panel is not a list of live codes (QA-142)",
        !!row && !/\d{6}/.test(String(row.subject ?? "")), JSON.stringify(row?.subject));
      const noRow = logs.find((l) => String(l.to ?? "").startsWith(`nobody.${stamp}`));
      ok("QA-1829b: ...and NOTHING was mailed for the address that does not exist", !noRow, JSON.stringify(noRow?.to));

      // ---- Drive the rest for real, with a challenge this file controls.
      const arm = async () => {
        const t = await db.collection("publictokens").findOne({ purpose: "password_reset", email: fpEmail, active: true }, { sort: { _id: -1 } });
        if (!t) return null;
        await db.collection("publictokens").updateOne({ _id: t._id }, { $set: { otp_hash: sha(CODE), otp_attempts: 0, otp_expires_at: new Date(Date.now() + 10 * 60_000) } });
        return t.token;
      };
      // Mint a challenge directly. The request path is covered above; the cooldown that blocks a
      // second request inside a minute is the feature working, not something to sleep through.
      const mint = async () => {
        const token = crypto.randomBytes(16).toString("hex");
        await db.collection("publictokens").insertOne({
          token, purpose: "password_reset", email: fpEmail, active: true,
          otp_hash: crypto.createHash("sha256").update(CODE).digest("hex"), otp_attempts: 0, otp_verified: false,
          otp_expires_at: new Date(Date.now() + 10 * 60_000),
          createdAt: new Date(), updatedAt: new Date(),
        });
        return token;
      };
      const tok = await arm();
      ok("QA-1829b [precondition] a password_reset token was minted for the real address", !!tok, "none found");

      if (tok) {
        const wrong = await post({ action: "verify", token: tok, code: "000000" });
        ok("QA-1829b: a wrong code is refused", wrong.status === 400, `got ${wrong.status}`);
        ok("QA-1829b: ...and the refusal does not say WHICH thing was wrong (no session/code split)",
          /expired or already been used/i.test(String(wrong.data?.error ?? "")), JSON.stringify(wrong.data?.error));

        const good = await post({ action: "verify", token: tok, code: CODE });
        ok("QA-1829b: the right code verifies", good.status === 200, `got ${good.status} ${JSON.stringify(good.data?.error ?? "")}`);

        const short = await post({ action: "reset", token: tok, password: "abc" });
        ok("QA-1829b: a password under 8 characters is refused", short.status === 400, `got ${short.status}`);
        const asEmail = await post({ action: "reset", token: tok, password: fpEmail });
        ok("QA-1829b: a password equal to the account's own email is refused", asEmail.status === 400, `got ${asEmail.status}`);

        const done = await post({ action: "reset", token: tok, password: FP2 });
        ok("QA-1829b: the new password is accepted", done.status === 200, `got ${done.status} ${JSON.stringify(done.data?.error ?? "")}`);

        // The whole point of the feature: the new password must work at the LOGIN door, and the
        // old one must not. A reset that changes a row but not the credential is not a reset.
        const newSess = await login(fpEmail, FP2);
        ok("QA-1829b: the account can sign in with the NEW password", !!newSess, "no session");
        const oldSess = await login(fpEmail, FP1);
        ok("QA-1829b: ...and the OLD password no longer works", !oldSess, "the old password still signs in");

        // SINGLE USE. The token was burned by the reset, so a replay must fail even though the
        // code is still correct - this is what stops a forwarded or shoulder-surfed code being
        // used twice.
        const replay = await post({ action: "reset", token: tok, password: "ThirdPass@789" });
        ok("QA-1829b: the token is SINGLE USE - replaying it is refused", replay.status === 400, `got ${replay.status}`);
        const stillNew = await login(fpEmail, FP2);
        ok("QA-1829b: ...and the replay changed nothing - the password set by the first reset still works",
          !!stillNew, "the replay altered the password");
      }

      // ---- ATTEMPT BURN. Five wrong tries must kill the challenge, so a 6-digit code cannot be
      // walked through.
      const tok2 = await mint();
      if (tok2) {
        for (let i = 0; i < 5; i++) await post({ action: "verify", token: tok2, code: "111111" });
        const afterBurn = await post({ action: "verify", token: tok2, code: CODE });
        ok("QA-1829b: five wrong tries burn the challenge - even the RIGHT code is then refused",
          afterBurn.status === 400, `got ${afterBurn.status}`);
      } else {
        ok("QA-1829b: a second challenge could be minted for the attempt-burn test", false, "none - this pin measured nothing");
      }

      // ---- EXPIRY, forced rather than waited for.
      const tok3 = await mint();
      if (tok3) {
        await db.collection("publictokens").updateOne({ token: tok3 }, { $set: { otp_expires_at: new Date(Date.now() - 1000) } });
        const expired = await post({ action: "verify", token: tok3, code: CODE });
        ok("QA-1829b: an expired code is refused", expired.status === 400, `got ${expired.status}`);
      } else {
        ok("QA-1829b: a third challenge could be minted for the expiry test", false, "none - this pin measured nothing");
      }

      // ---- A DEACTIVATED ACCOUNT MUST NOT BE ABLE TO START A RESET. Otherwise this door mails a
      // working code to somebody the system has switched off - the same population authorize()
      // refuses (auth.ts:53-54), and QA-2014 is the row for a check that was narrower than that one.
      // ---- QA-2099: THIS PIN COULD NOT FAIL, AND THE CHECKER MEASURED IT — deleting the
      // account-state guard entirely left the suite at 56/0. The reason is the fixture, not the
      // assertion: it reused an address that had just requested a code, so `emailChallengeGate`'s
      // 60-second cooldown was already refusing the send. "No mail was sent" was true for a reason
      // that had nothing to do with the guard being tested.
      //
      // A FRESH ADDRESS PER STATE. Each account below has never requested anything, so the only
      // thing that can stop its mail is the guard itself.
      //
      // QA-2200 (checker, cycle 2) — THE CLAIM THAT USED TO STAND HERE WAS FALSE, AND IT IS THE
      // SAME DEFECT CLASS THIS BLOCK EXISTS TO HAVE FIXED, ONE LAYER IN. It said "three states
      // are covered rather than one, because `authorize()` refuses on three different grounds".
      // It covered ONE ground three times: `approval: "reject"` and `drop: true` BOTH also set
      // `active = false`, so all three fixtures were disqualified by the `active` clause and the
      // checker measured it — deleting `dropped`, `Pending` and `Rejected` from `canSignIn` left
      // the suite at 70/0. Pending had no fixture at all.
      //
      // So two states below are driven by a DIRECT DATABASE WRITE rather than through PATCH,
      // for one reason, and QA-2247 corrected the reason after the first version overstated it.
      //
      // WHAT IS TRUE: every **PATCH** route that sets an approval outcome also deactivates the
      // account (`approval: "reject"` sets approval_status AND active=false), so an
      // approval-only state is unreachable through the PATCH door these fixtures use.
      //
      // WHAT THE FIRST VERSION CLAIMED AND WAS FALSE: that NO route can express it. `POST
      // /api/users` — the route called two lines above — passes `active: body.active ?? true`
      // and `approval_status: body.approval_status` straight through (`users/route.ts`), so the
      // fixture could be built at creation. The checker measured 201/201 doing exactly that.
      // The sentence was written from the door in front of me rather than from the routes.
      //
      // The direct write stays because it is the narrower instrument — it sets ONE field on an
      // already-created account, so the fixture differs from its siblings in exactly the way
      // under test — but it is now a choice, not a necessity, and the precondition below is what
      // makes either route safe: it asserts active===true, so a fixture that quietly became
      // another copy of [deactivated] says so instead of passing.
      for (const [idx, [label, mutate]] of [
        ["deactivated", (id) => req(admin, "PATCH", `/api/users/${id}`, { active: false })],
        ["rejected", (id) => req(admin, "PATCH", `/api/users/${id}`, { approval: "reject" })],
        ["dropped", (id) => req(admin, "PATCH", `/api/users/${id}`, { drop: true })],
        // active stays TRUE on both of these - the approval clause is the only disqualification
        ["pending-only", (id, email) => db.collection("users").updateOne({ email }, { $set: { approval_status: "Pending" } })],
        ["rejected-only", (id, email) => db.collection("users").updateOne({ email }, { $set: { approval_status: "Rejected" } })],
      ].entries()) {
        const stEmail = `fpst.${label}.${stamp}@vidysea-test.local`;
        const made2 = await req(admin, "POST", "/api/users", { name: `FPST ${label} ${stamp}`, email: stEmail, password: "StateFix@123", role: "Trainer" });
        if (made2.status !== 201 || !made2.data?.item?._id) {
          ok(`QA-2099 [${label}] the fixture account was created`, false, `got ${made2.status} - this pin measured nothing`);
          continue;
        }
        await mutate(made2.data.item._id, stEmail);

        // The approval-only fixtures are worth nothing if the write did not land the way they
        // claim, so assert the SHAPE rather than trusting the update: active must still be true,
        // or the pin has quietly become another copy of [deactivated].
        if (label.endsWith("-only")) {
          const row = await db.collection("users").findOne({ email: stEmail });
          ok(`QA-2200 [${label}] the fixture is disqualified ONLY by its approval status`,
            !!row && row.active === true && row.dropped !== true
              && row.approval_status === (label === "pending-only" ? "Pending" : "Rejected"),
            `active=${row?.active} dropped=${row?.dropped} approval_status=${JSON.stringify(row?.approval_status)} - if active is false this pin is a duplicate of [deactivated] and proves nothing about the approval clause`);
        }

        // QA-2160 — MY OWN CYCLE-2 REWRITE FAILED FIVE WAYS ON THE FIRST HONEST WALL, AND BOTH
        // CAUSES WERE IN THIS FIXTURE, NOT IN THE DOOR. Worth writing down, because I introduced
        // them while "fixing" a pin that could not fail — a wrong pin is the same defect class as
        // an inert one, arriving from the other side.
        //
        //   (a) COUNTING MAIL ROWS ABSOLUTELY. `POST /api/users` sends a welcome mail
        //       (`users/route.ts:101`), so a freshly created account ALREADY has one row before
        //       this door is touched. `mailed === 0` measured that welcome mail and called it a
        //       leaked reset code. The version I replaced used a before/after DELTA and was immune;
        //       I dropped the delta while removing the stale-address bug and swapped one fixture
        //       defect for another. The delta is back, and it is taken AFTER the mutation so the
        //       welcome mail is inside the baseline where it belongs.
        //
        //   (b) THE PER-IP BUDGET IS SHARED BY THE WHOLE SUITE. The door is
        //       `rateLimit("pwreset-req:" + clientKey(req), 5, 1h)` — five per hour per CLIENT, and
        //       earlier blocks in this file had already spent them, so states 2 and 3 got 429 and
        //       the pin reported a state leak that was really a queue. Each state now arrives from
        //       its own `x-forwarded-for`, which is the key `clientKey()` actually reads
        //       (`rate-limit.ts`, last hop). That is the production keying path, exercised rather
        //       than bypassed — no guard is weakened and no test-only escape hatch exists to rot.
        const from = { "x-forwarded-for": `203.0.113.${1 + idx}` };
        const mailRows = async () => ((await req(admin, "GET", "/api/test-email")).data?.log ?? []).filter((l) => l.to === stEmail).length;
        const before = await mailRows();
        const r = await req("", "POST", "/api/public/forgot-password", { action: "request", email: stEmail }, from);
        const after = await mailRows();

        ok(`QA-2099 [${label}] the answer is the SAME - the door does not leak the account's state`,
          r.status === 200, `got ${r.status}${r.status === 429 ? " - the per-IP budget was spent; this pin measured the queue, not the door" : ""}`);
        ok(`QA-2099 [${label}] ...and NO code is mailed, on an address that has never asked before`,
          after === before, `mail rows for ${stEmail}: ${before} -> ${after}. The address is fresh, so the 60s cooldown cannot be the reason; the welcome mail is inside the baseline.`);

        // QA-2161 — MEASURED, NOT ASSUMED: I mutated the state guard to `canSignIn = !!doc` and
        // rebuilt. [deactivated] and [rejected] both went RED (1 -> 2 mail rows), so those two
        // pins have real power over the thing they name. **[dropped] STAYED GREEN**, and the
        // reason is not that the guard is good:
        //
        //   `drop: true` RENAMES the address (`users/[id]/route.ts:175`, to
        //   `dropped.<ts>.<original>`), so `User.findOne({ email })` on the original address
        //   returns null and the branch is never reached. The [dropped] pin above is therefore
        //   pinning the RENAME, not the state check - a true and worthwhile property, but not the
        //   one its label implies, and it cannot fail under any mutation of `canSignIn`.
        //
        // Saying that plainly is the point. An assertion whose label promises more than its
        // mutation-power delivers is this repo's most-repeated defect, and it is invisible in a
        // pass count. So the dropped STATE gets its own pin below, aimed at the address that
        // still resolves to the row - the renamed one. That request DOES reach the guard, and it
        // is the realistic hostile case too: the internal address is derivable from the original.
        if (label === "dropped") {
          // There is NO GET handler on /api/users/[id] - the first version of this asked for one
          // and got `undefined`, and the precondition caught it rather than letting the pin
          // report a pass over a measurement it never made. Read the row from the database
          // instead, keyed on `dropped_email` (set to the original address by
          // `users/[id]/route.ts:174`) so no ObjectId import is needed.
          const dropped = await db.collection("users").findOne({ dropped_email: stEmail });
          const dEmail = dropped?.email;
          ok("QA-2161 [precondition] dropping renamed the address, so the original no longer resolves",
            typeof dEmail === "string" && dEmail !== stEmail && dEmail.includes(stEmail),
            `email after drop: ${JSON.stringify(dEmail)} (expected a dropped.<ts>. prefix on ${stEmail})`);
          if (dEmail && dEmail !== stEmail) {
            const dRows = async () => ((await req(admin, "GET", "/api/test-email")).data?.log ?? []).filter((l) => l.to === dEmail).length;
            const dBefore = await dRows();
            const dr = await req("", "POST", "/api/public/forgot-password", { action: "request", email: dEmail }, { "x-forwarded-for": "203.0.113.90" });
            const dAfter = await dRows();
            ok("QA-2161 [dropped] the RENAMED address answers the same - it does not leak that the row exists",
              dr.status === 200, `got ${dr.status}`);
            ok("QA-2161 [dropped] ...and NO code is mailed to it - this one DOES reach the state guard",
              dAfter === dBefore, `mail rows for ${dEmail}: ${dBefore} -> ${dAfter}. This address resolves to a dropped row, so only the state guard can refuse it.`);
          }
        }
        if (label !== "dropped") await req(admin, "PATCH", `/api/users/${made2.data.item._id}`, { drop: true });
      }
      if (subjectId) await req(admin, "PATCH", `/api/users/${subjectId}`, { drop: true });
    } catch (e) {
      ok("QA-1829b: the block ran without error", false, String((e && e.message) || e));
    } finally {
      try { await client.close(); } catch {}
    }
  }
}

// ---- QA-2277/QA-2278 (checker, cycle 9) - THE PIN THAT ENDS THE CLASS, NOT THE INSTANCE ----
//
// LABELLED FOR THE FINDINGS IT CLOSES, and that is a correction: this block first went in as
// `QA-2276`, a number picked by hand out of a verdict's neighbourhood rather than reserved. It was
// already taken - by the qa-2250 cycle-5 checker - so the wall printed two different units'
// assertions under one id. `qa/tools/reserve-id.mjs --append` exists precisely to make that
// impossible, and CLAUDE.md carries a paragraph about the day five of these happened. A new id was
// not the right repair either: this block is not a finding, it is the FIX for QA-2277 and QA-2278,
// so it carries their names.
//
// Cycles 6-9 each closed a real hole and each left the CLASS untouched. Every one of those pins is
// a regex over source text, and a regex over source text can always be walked around: the checker
// re-created QA-2272 by writing the plain setter with SINGLE quotes (the pin tested for two double
// ones), and again by parking the functional updater in a helper nothing calls. Four cycles of
// patching the last evasion is four cycles of not addressing why an evasion is always available.
//
// This drives the journey in a real browser instead, and kills the whole family at once - a plain
// setter, a single-quoted plain setter, an always-disabled control, a control on the wrong step, an
// updater in dead code - because none of them survives a person actually completing the journey.
// `e2e-rendered-candidates.mjs` already carries the mechanism; this borrows it.
//
// It costs one chromium launch and NO waiting: the cooldown is never waited out, it is USED. The
// resend happens INSIDE the cooldown, which is exactly the case the keep-branch exists for.
{
  const uiDbUrl = process.env.MONGODB_URL, uiDbName = process.env.MONGODB_DB;
  if (!uiDbUrl || !uiDbName) {
    ok("QA-2277/QA-2278 [precondition] MONGODB_URL/MONGODB_DB are set so the journey can be armed", false,
      "not set - this block measured NOTHING, and says so in red rather than passing quietly");
  } else {
    let uiBrowser, uiClient;
    try {
      const { chromium } = await import("playwright");
      uiClient = new MongoClient(uiDbUrl);
      await uiClient.connect();
      const uiDb = uiClient.db(uiDbName);
      const uiSha = (x) => crypto.createHash("sha256").update(x).digest("hex");
      const UI_CODE = "424242";
      const uiEmail = "fp-ui." + stamp + "@vidysea-test.local";
      await uiDb.collection("users").insertOne({
        name: "FP UI", email: uiEmail, role: "Admin", active: true,
        password_hash: "x", createdAt: new Date(), updatedAt: new Date(),
      });

      try {
        uiBrowser = await chromium.launch({ headless: true });
      } catch (e) {
        // Not a skip. A missing browser means this block verified NOTHING, and it says so in red.
        ok("QA-2277/QA-2278 [precondition] chromium launches from the `playwright` devDependency", false,
          String(e.message).slice(0, 200) + " -- run `npx playwright install chromium`");
        throw e;
      }
      // The per-IP `pwreset-req` limiter is 5/hour and PER PROCESS, so a browser sharing the wall's
      // own client key arrives with the budget already spent by earlier suites - the page then shows a
      // refusal, never reaches the code step, and this block reports the PRODUCT broken when what
      // refused was the queue. Measured, not guessed: the first run of this pin failed exactly that
      // way. Every arm gets its own client key, and the reach-the-code-step assertion below is the
      // precondition that proves it worked.
      const uiCtx = await uiBrowser.newContext({
        viewport: { width: 1280, height: 900 },
        extraHTTPHeaders: { "x-forwarded-for": "10.77." + (stamp % 250 + 1) + ".9" },
      });
      const uiPage = await uiCtx.newPage();

      await uiPage.goto(BASE + "/forgot", { waitUntil: "networkidle" });
      // This page renders inside a <Suspense> boundary, like /erp/login. Querying after
      // domcontentloaded reports controls missing that are simply not hydrated yet - that exact
      // trap produced a false "there is no link to /forgot" finding on this unit.
      const uiEmailBox = uiPage.locator('input[type="email"], input[name="email"]').first();
      await uiEmailBox.waitFor({ timeout: 20000 });
      await uiEmailBox.fill(uiEmail);
      await uiPage.locator('button[type="submit"]').first().click();

      const uiCodeBox = uiPage.locator('input[inputmode="numeric"]').first();
      await uiCodeBox.waitFor({ timeout: 20000 }).catch(() => {});
      const reachedCode = (await uiCodeBox.count()) > 0;
      ok("QA-2277/QA-2278: the page reaches the code step after asking for a code",
        reachedCode, "url=" + uiPage.url() + " body=" + (await uiPage.locator("body").innerText()).slice(0, 160));

      // Arm the challenge the PAGE is holding with a code we know. The code is never in the
      // response - that is QA-142 working - so this is the only way to complete the journey.
      const uiArmed = await uiDb.collection("publictokens").updateOne(
        { purpose: "password_reset", email: uiEmail, active: true },
        { $set: { otp_hash: uiSha(UI_CODE), otp_attempts: 0 } },
      );
      ok("QA-2277/QA-2278 [precondition] the challenge the page is holding was armed with a known code",
        uiArmed.modifiedCount === 1,
        "modifiedCount=" + uiArmed.modifiedCount + " - nothing armed means every assertion below would be vacuous");

      const uiResend = uiPage.getByRole("button", { name: /send another code/i }).first();
      const resendCount = await uiResend.count();
      const resendEnabled = resendCount ? await uiResend.isEnabled() : false;
      ok("QA-2277/QA-2278: the code step offers a resend control a person can actually press",
        resendCount > 0 && resendEnabled,
        "count=" + resendCount + " enabled=" + resendEnabled + " - absent, on another step, or permanently disabled all fail HERE, and all three passed the structural pins at some point in this unit's history");

      if (reachedCode && resendCount > 0 && resendEnabled && uiArmed.modifiedCount === 1) {
        // INSIDE the cooldown on purpose: the server answers with no token, and the page must KEEP
        // the one it holds. This is the exact journey QA-2201/QA-2251/QA-2259 broke four times.
        await uiResend.click();
        await uiPage.waitForTimeout(1500);
        await uiCodeBox.fill(UI_CODE);
        await uiPage.locator('button[type="submit"]').first().click();
        const uiPw = uiPage.locator('input[type="password"]').first();
        await uiPw.waitFor({ timeout: 20000 }).catch(() => {});
        ok("QA-2277/QA-2278: after an in-cooldown resend, the code the person ALREADY HOLDS still works and the journey continues",
          (await uiPw.count()) > 0,
          "still on: " + (await uiPage.locator("body").innerText()).slice(0, 220) + " - the page threw away the token it was holding when the cooldown response carried none, which is QA-2251 by whichever route the source found this time");
      }

      await uiDb.collection("users").deleteOne({ email: uiEmail });
    } catch (e) {
      ok("QA-2277/QA-2278: the browser journey ran without error", false, String((e && e.message) || e).slice(0, 300));
    } finally {
      try { if (uiBrowser) await uiBrowser.close(); } catch {}
      try { if (uiClient) await uiClient.close(); } catch {}
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
