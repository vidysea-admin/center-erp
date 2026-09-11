// Shared harness for the section-wise eval suites (2026-08-13). The older suites carry their own
// copy of this block; new suites import it so an assertion-style change happens in one place.
//
// QA-1692: requireLocalBase (db-guard.mjs) already exists for exactly this — a write-capable
// suite pointed at a non-local BASE_URL writes through whatever server that is, production
// included, with no test-database name to catch it. e2e-roles.mjs/seed-sample.mjs already call
// it; this file's own BASE export reached nine suites (every e2e-eval-*.mjs plus
// e2e-govt-batch-id.mjs and e2e-rendered-candidates.mjs) without it. One guard here covers all nine.
import { requireLocalBase } from "./db-guard.mjs";
export const BASE = requireLocalBase("e2e-lib", process.env.BASE_URL || "http://localhost:3000/erp");
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

let pass = 0, fail = 0;
export const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + " " + (x ?? "")); } };

export async function login(email, password) {
  const csrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email, password }),
    redirect: "manual",
  });
  const session = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]).flat().filter(Boolean)
    .map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  if (!session) return null; // caller decides whether that is fatal
  return [csrfCookie, session].join("; ");
}

export async function adminLogin() {
  const c = await login("admin@vidysea.com", ADMIN_PASSWORD);
  if (!c) { console.log("FATAL: cannot log in as admin@vidysea.com"); process.exit(1); }
  return c;
}

export async function req(cookie, method, path, body, expect) {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const res = await fetch(BASE + path, {
    method,
    headers: isForm ? { cookie } : { "Content-Type": "application/json", cookie },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (expect !== undefined) ok(`${method} ${path} → ${expect}`, res.status === expect, `(got ${res.status}: ${JSON.stringify(data).slice(0, 150)})`);
  // -111: every error any suite sees is scanned for a ledger code; finish() asserts none leaked.
  if (res.status >= 400 && typeof data?.error === "string" && CODE_RX.test(data.error)) codeLeaks.push(`${method} ${path} → ${data.error.slice(0, 100)}`);
  return { status: res.status, data };
}
const CODE_RX = /\b(?:Rules?|DEC|QA)[-\s]?T?\d+\b/;
const codeLeaks = [];

export function finish() {
  ok(`-111: no API error in this run carries a Rule/DEC/QA code (${codeLeaks.length} leak(s))`, codeLeaks.length === 0, codeLeaks.slice(0, 5).join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// Run-unique stamp — key collisions with a previous run of the same suite read as "existing
// entity" and corrupt assertions (the e2e-govt.mjs lesson).
export const stamp = (p = "T") => p + Date.now().toString().slice(-7);
export const phone = (prefix) => prefix + Date.now().toString().slice(-(10 - String(prefix).length)); // QA-141: fixtures are exactly 10 digits now
// LOCAL calendar date (what the UI sends) — see e2e.mjs note on the IST-midnight window.
export const today = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; };

// ---- QA-2449: a leak detector must not key on a symbol the fix is allowed to remove ----
//
// The live QA-2447 probe reported 12 passed / 0 failed while the leak sat in a file it had already
// written to disk. It asserted on `₹` followed by digits. The product had correctly masked the
// rupee-prefixed amount to `₹—`, so the regex matched nothing and printed PASS, while `445599` —
// the figure a person had TYPED into the note — sat unmasked in the very same sentence.
//
// THE SHAPE IS THE INVERSE OF THE USUAL VACUOUS PASS, and that is why it is worth a shared helper.
// Normally a false assertion passes because nothing exercised it. This one passed BECAUSE THE
// PRODUCT HALF-WORKED: the fix removed exactly the token the detector was looking for, so a partial
// repair read as a complete one. A detector keyed to a currency symbol is blind precisely where
// that symbol has been stripped.
//
// So the rule is: hunt BARE DIGIT RUNS, the same shape `redactFiguresInText` itself uses, with the
// date shapes it protects excluded first. This is deliberately an INDEPENDENT re-derivation and not
// an import of the product function — a detector that shares code with the thing it measures agrees
// with it by construction, including where both are wrong.
//
// `allowCodes` is for strings a test deliberately leaves whole (a UTR, a batch code). Pass them and
// say why at the call site; every figure not named there is a finding.
export function bareFigures(text, opts = {}) {
  const s = String(text ?? "");
  const allow = opts.allowCodes ?? [];
  let t = s;
  for (const c of allow) t = t.split(String(c)).join(" ");
  // Park the same three date shapes the product protects, judged by value and not by shape —
  // `4242-42-42` is a perfectly good date SHAPE and month 42 is not a month.
  const realDate = (yy, mm, dd) => {
    const y = Number(yy), mo = Number(mm), d = Number(dd);
    return y >= 1900 && y <= 2199 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
  };
  t = t
    .replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3}(?!\d))?)?(?:Z|[+-]\d{2}:\d{2})?/g,
      (m, yy, mm, dd, hh, mi, ss) => (realDate(yy, mm, dd) && Number(hh) <= 23 && Number(mi) <= 59
        && (ss === undefined || Number(ss) <= 59) ? " " : m))
    .replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, (m, yy, mm, dd) => (realDate(yy, mm, dd) ? " " : m))
    .replace(/(?<!\d)(\d{2})[-\/.](\d{2})[-\/.](\d{4})(?!\d)/g, (m, dd, mm, yy) => (realDate(yy, mm, dd) ? " " : m));
  // Any run of digits and grouping separators holding three or more DIGITS. Two-digit groups
  // survive, so a day, a month and a small count still read normally — 100 and up does not.
  const hits = [];
  for (const m of t.matchAll(/[\d][\d,.]*/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 3) hits.push(m[0]);
  }
  return hits;
}
