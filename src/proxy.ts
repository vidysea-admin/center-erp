import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

export async function proxy(req: NextRequest) {
  // With basePath configured, nextUrl.pathname is normally reported without the
  // prefix — strip defensively so both shapes behave identically.
  const pathname = req.nextUrl.pathname.replace(/^\/erp(?=\/|$)/, "") || "/";
  if (process.env.PROXY_DEBUG) console.log("[proxy]", JSON.stringify(req.nextUrl.pathname), "->", JSON.stringify(pathname));
  // An account-specific welcome link is an explicit browser-account switch. Clear every Auth.js
  // session-token chunk on the navigation response itself, before the login form can render. The
  // client also signs out as defence in depth, but a client fetch must not be the only boundary:
  // browsers have retained the old privileged cookie even after that endpoint answered 200.
  if (pathname === "/login" && req.nextUrl.searchParams.get("switch") === "1" && req.nextUrl.searchParams.get("email")) {
    const res = NextResponse.next();
    for (const { name } of req.cookies.getAll()) {
      if (/^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name)) {
        // QA-2451 (S1, live checker on -302, read off the wire in a visible browser). This used to
        // be `res.cookies.delete(name)`, which emits
        //     Set-Cookie: __Secure-authjs.session-token=; Path=/; Expires=Thu, 01 Jan 1970 ...
        // with NO `Secure` attribute. A cookie whose NAME carries the `__Secure-` prefix may only be
        // set by a Set-Cookie that bears `Secure`; the browser is REQUIRED to reject one that does
        // not. So the deletion was correct in the source, present in the response, and inert in the
        // jar: the old privileged session survived the switch in 3 of 4 production runs - including
        // one where the checker issued no requests at all - and the invited person then reached /erp
        // WITHOUT ENTERING A PASSWORD, inside the previous Admin's account (role=Admin, GET
        // /api/users 200). The `signOut()` fallback four lines above is a race, and it won once.
        // The comment above already said a client fetch must not be the only boundary. It was.
        //
        // AND THE WALL COULD NOT HAVE SEEN IT. `e2e-password.mjs` has asserted "opening the
        // invitation clears the old Admin session before submit" for several releases and it passes,
        // because a local wall runs over http, where Auth.js issues the UNPREFIXED
        // `authjs.session-token` - for which a bare deletion is perfectly valid. The defect lives
        // only in the shape production uses. That is why the pin beside that arm asserts the emitted
        // HEADER for the prefixed name, which can be exercised over http.
        //
        // Expire it with the attributes it was ISSUED with rather than asking for a delete: `Secure`
        // exactly when the name demands it, so the local unprefixed cookie keeps working unchanged.
        res.cookies.set(name, "", {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: name.startsWith("__Secure-"),
          expires: new Date(0),
          maxAge: 0,
        });
      }
    }
    res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.headers.set("Pragma", "no-cache");
    return res;
  }
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    // QA-1829b: THIS FILE IS THE GATE, and forgetting it would have shipped a forgot-password page
    // that only signed-in people could open - useless to the one person who needs it. The unit plan
    // for this feature stated "there is no middleware in this repo", which is false: Next 16 calls it
    // proxy.ts. Caught because the page was fetched without a session and answered 307 to /login.
    // The API half needed nothing - /api/public/ is already allowed below.
    pathname.startsWith("/forgot") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/files") ||
    // Public capability-URL pages (2026-08-11): candidate self-registration + feedback.
    // The random token in the path is the credential; the handlers validate it.
    pathname.startsWith("/p/") ||
    pathname.startsWith("/api/public/") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }
  const cookieName = req.cookies.has("__Secure-authjs.session-token") ? "__Secure-authjs.session-token" : "authjs.session-token";
  const token = await getToken({ req, secret: process.env.AUTH_SECRET!, cookieName, salt: cookieName });
  if (!token) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("callbackUrl", pathname);
    // Same trap as sign-out (2026-08-12): req.nextUrl carries the host the SERVER sees,
    // which behind the production proxy is the instance's internal address. Rebuild on the
    // forwarded origin when the proxy supplies one, so the browser is never sent somewhere
    // it cannot resolve.
    const fwdHost = req.headers.get("x-forwarded-host");
    if (fwdHost) {
      url.protocol = `${req.headers.get("x-forwarded-proto") ?? "https"}:`;
      // Order matters: the URL host setter leaves an existing port in place when the new
      // value carries none, so the internal :3000 survives unless it is cleared first.
      url.port = "";
      url.host = fwdHost;
    }
    return NextResponse.redirect(url);
  }
  // Signed-in pages must never sit in the browser's cache: after signing out, pressing Back
  // would otherwise redisplay a rendered screen full of someone's data. no-store also
  // disables the back/forward cache, so Back re-requests and lands on /login.
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.headers.set("Pragma", "no-cache");
  return res;
}

export const config = {
  // "/" listed explicitly — the pattern below does not match the bare root path,
  // which left the Home route unguarded under basePath (verified 2026-08-10).
  // -81 (15/08, Umesh's video test): /api/upload is EXCLUDED on purpose. Whenever the proxy
  // runs, Next.js clones and buffers the request body in memory, capped by
  // experimental.proxyClientMaxBodySize = 10 MB by default — bodies beyond that are silently
  // truncated, req.formData() then fails to parse, and the route answered 413. That was the
  // "~8-10 MB upload cap" OPERATIONS.md blamed on the reverse proxy; the local server logged
  // the real line ("Request body exceeded 10MB for /erp/api/upload"). Skipping the proxy for
  // this one path streams the body straight to the handler with no cap and no RAM buffer;
  // the route still authenticates itself (requireUser + requireEdit) — same 401 as before.
  matcher: ["/", "/((?!_next/static|_next/image|favicon.ico|api/upload$).*)"],
};
