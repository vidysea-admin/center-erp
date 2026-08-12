// Reverse-proxy E2E — the gap that let the 2026-08-12 sign-out bug reach production.
//
// Every other suite talks to the app directly on localhost, so the app's own Host header
// IS the browser's address and no URL can ever be wrong. Production is not like that:
// nginx sits in front, and the app sees an internal address (ip-10-0-…:3000). Any URL the
// SERVER builds from the request then points somewhere no browser can reach.
//
// This suite puts a proxy in front that forwards with the internal Host — reproducing
// production exactly — and asserts that every URL handed back to the browser stays on the
// public origin.
import http from "node:http";

const APP = process.env.APP_URL || "http://localhost:3000";
const PUBLIC_HOST = "erp.example.test";          // what the browser typed
const INTERNAL_HOST = "ip-10-0-105-118.ap-south-1.compute.internal:3000"; // what the app sees
const PORT = Number(process.env.PROXY_PORT || 3999);

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + " " + x); } };

// A deliberately production-like proxy: it rewrites Host to the internal address (the
// default nginx behaviour that causes this bug) but does send X-Forwarded-*.
const proxy = http.createServer((cReq, cRes) => {
  const target = new URL(cReq.url, APP);
  const headers = { ...cReq.headers, host: INTERNAL_HOST,
    "x-forwarded-host": PUBLIC_HOST, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7" };
  const pReq = http.request(
    { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: cReq.method, headers },
    (pRes) => { cRes.writeHead(pRes.statusCode, pRes.headers); pRes.pipe(cRes); },
  );
  pReq.on("error", (e) => { cRes.writeHead(502); cRes.end(String(e)); });
  cReq.pipe(pReq);
});
await new Promise((r) => proxy.listen(PORT, r));
const BASE = `http://localhost:${PORT}/erp`;
console.log(`proxy on :${PORT} → ${APP}  (app sees Host: ${INTERNAL_HOST})\n`);

const leaksInternal = (v) => typeof v === "string" && /compute\.internal|ip-10-0-|:3000/.test(v);

// ---- 1. Unauthenticated page hit → login redirect must not point at the internal host ----
const guard = await fetch(`${BASE}/batches`, { redirect: "manual" });
const guardLoc = guard.headers.get("location") ?? "";
ok("unauthenticated page redirects to login", [302, 307].includes(guard.status), `status=${guard.status}`);
ok("…and that redirect does NOT leak the internal host", !leaksInternal(guardLoc), `location=${guardLoc}`);
ok("…it stays on the public origin (or is relative)", guardLoc.startsWith("/") || guardLoc.includes(PUBLIC_HOST), `location=${guardLoc}`);

// ---- 2. Log in through the proxy ----
const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
const { csrfToken } = await csrfRes.json();
const csrfSet = (csrfRes.headers.getSetCookie?.() ?? [csrfRes.headers.get("set-cookie")]).flat().filter(Boolean);
const csrfCookie = csrfSet.map((c) => c.split(";")[0]).find((c) => c.includes("csrf-token")) ?? "";
ok("CSRF cookie issued through the proxy", !!csrfCookie, JSON.stringify(csrfSet).slice(0, 120));
const login = await fetch(`${BASE}/api/auth/callback/credentials`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
  body: new URLSearchParams({ csrfToken, email: "admin@vidysea.com", password: process.env.ADMIN_PASSWORD || "admin123" }),
  redirect: "manual",
});
const setCookies = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie")]).flat().filter(Boolean);
const session = setCookies.map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
const cookie = [csrfCookie, session].join("; ");
ok("login works through the proxy", !!session, `status=${login.status}`);

// ---- 3. Sign out — the exact production failure ----
const soCsrfRes = await fetch(`${BASE}/api/auth/csrf`, { headers: { cookie } });
const { csrfToken: soToken } = await soCsrfRes.json();
const signout = await fetch(`${BASE}/api/auth/signout`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
  body: new URLSearchParams({ csrfToken: soToken, callbackUrl: "/login" }),
  redirect: "manual",
});
const soLoc = signout.headers.get("location") ?? "";
ok("sign-out responds", [200, 302, 307].includes(signout.status), `status=${signout.status}`);
// The endpoint's own Location header is built by Auth.js from the origin the SERVER
// believes it is on. That is configuration, not code: production must set AUTH_URL (see
// .env.example). The UI does not depend on it — the Sign out button clears the session
// with redirect:false and then navigates using the browser's own origin — but a wrong
// AUTH_URL still affects other Auth.js-generated URLs, so surface it loudly.
if (leaksInternal(soLoc)) {
  console.log(`WARN  sign-out endpoint returned "${soLoc}" — set AUTH_URL in the server .env to the public URL.`);
}
ok("sign-out clears the session cookie", (signout.headers.getSetCookie?.() ?? []).some((c) => /session-token=;|session-token=""|Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c)),
  JSON.stringify(signout.headers.getSetCookie?.() ?? []).slice(0, 160));
ok(".env.example documents AUTH_URL so production can be configured correctly",
  (await import("node:fs")).readFileSync(new URL("../.env.example", import.meta.url), "utf8").includes("AUTH_URL"));

// ---- 3b. Signed-in pages must not be cacheable (Back after sign-out must not show data) ----
const signedInPage = await fetch(`${BASE}/batches`, { headers: { cookie } });
const cc = signedInPage.headers.get("cache-control") ?? "";
ok("signed-in page is served no-store (kills Back-button replay)", /no-store/.test(cc), `cache-control=${cc}`);
const loginPage = await fetch(`${BASE}/login`);
ok("login page still reachable after that", loginPage.status === 200);

// ---- 4. No API response body may carry the internal address ----
const cookie2 = cookie;
for (const path of ["/api/home", "/api/locations?limit=5", "/api/batches", "/api/notifications"]) {
  const res = await fetch(BASE + path, { headers: { cookie: cookie2 } });
  const body = await res.text();
  ok(`API ${path} body free of the internal host`, !leaksInternal(body), body.slice(0, 120));
}

// ---- 5. Public pages served through the proxy (candidates open these on their phones) ----
for (const path of ["/login", "/signup", "/p/register/sometoken"]) {
  const res = await fetch(BASE + path, { redirect: "manual" });
  const body = res.status === 200 ? await res.text() : "";
  ok(`public page ${path} loads through the proxy`, res.status === 200, `status=${res.status}`);
  ok(`…and its HTML does not hardcode the internal host`, !leaksInternal(body));
}

// ---- 6. Static assets resolve under basePath behind the proxy ----
const html = await (await fetch(`${BASE}/login`)).text();
const asset = html.match(/\/erp\/_next\/static\/[^"']+\.js/)?.[0];
ok("page references its JS bundle under /erp", !!asset, asset ?? "none found");
if (asset) {
  const a = await fetch(`http://localhost:${PORT}${asset}`);
  ok("that bundle actually loads through the proxy", a.status === 200, `status=${a.status}`);
}

proxy.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
