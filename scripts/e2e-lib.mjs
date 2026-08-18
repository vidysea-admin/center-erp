// Shared harness for the section-wise eval suites (2026-08-13). The older suites carry their own
// copy of this block; new suites import it so an assertion-style change happens in one place.
export const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
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
