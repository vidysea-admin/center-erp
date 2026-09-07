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
const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
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
if (admin) {
  const me = (await req(admin, "GET", "/api/users?limit=200")).data?.items?.find((u) => u.email === "admin@vidysea.com");
  if (me) {
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
  if (s2) {
    let sawLimit = false;
    for (let i = 0; i < 8; i++) {
      const r = await req(s2, "POST", "/api/me/password", { current_password: `wrong-${i}`, new_password: "Whatever12" });
      if (r.status === 429) { sawLimit = true; break; }
    }
    ok("QA-1829a: repeated wrong-current-password attempts are rate limited", sawLimit, "no 429 in 8 attempts");
  }
}

// ---- tidy up: the subject is deactivated, never left able to sign in.
if (admin && subjectId) {
  const off = await req(admin, "PATCH", `/api/users/${subjectId}`, { active: false });
  ok("cleanup: the throwaway subject is deactivated", off.status === 200, `got ${off.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
