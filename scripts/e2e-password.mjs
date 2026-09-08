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
          `token=${JSON.stringify(asked.data?.token)} - /forgot does setToken(d.token ?? "") and then verifies with it`);

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
          otp_hash: sha(CODE), otp_attempts: 0, otp_verified: false,
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
      // thing that can stop its mail is the guard itself. Three states are covered rather than
      // one, because `authorize()` refuses on three different grounds and a guard that covers
      // some of them is this repo's most-repeated shape (QA-1997).
      for (const [label, mutate] of [
        ["deactivated", (id) => req(admin, "PATCH", `/api/users/${id}`, { active: false })],
        ["rejected", (id) => req(admin, "PATCH", `/api/users/${id}`, { approval: "reject" })],
        ["dropped", (id) => req(admin, "PATCH", `/api/users/${id}`, { drop: true })],
      ]) {
        const stEmail = `fpst.${label}.${stamp}@vidysea-test.local`;
        const made2 = await req(admin, "POST", "/api/users", { name: `FPST ${label} ${stamp}`, email: stEmail, password: "StateFix@123", role: "Trainer" });
        if (made2.status !== 201 || !made2.data?.item?._id) {
          ok(`QA-2099 [${label}] the fixture account was created`, false, `got ${made2.status} - this pin measured nothing`);
          continue;
        }
        await mutate(made2.data.item._id);
        const r = await post({ action: "request", email: stEmail });
        const mailed = ((await req(admin, "GET", "/api/test-email")).data?.log ?? []).filter((l) => l.to === stEmail).length;
        ok(`QA-2099 [${label}] the answer is the SAME - the door does not leak the account's state`,
          r.status === 200, `got ${r.status}`);
        ok(`QA-2099 [${label}] ...and NO code is mailed, on an address that has never asked before`,
          mailed === 0, `${mailed} mail row(s) for ${stEmail} - the cooldown cannot be the reason here`);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
