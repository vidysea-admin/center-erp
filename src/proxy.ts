import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

export async function proxy(req: NextRequest) {
  // With basePath configured, nextUrl.pathname is normally reported without the
  // prefix — strip defensively so both shapes behave identically.
  const pathname = req.nextUrl.pathname.replace(/^\/erp(?=\/|$)/, "") || "/";
  if (process.env.PROXY_DEBUG) console.log("[proxy]", JSON.stringify(req.nextUrl.pathname), "->", JSON.stringify(pathname));
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
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
  matcher: ["/", "/((?!_next/static|_next/image|favicon.ico).*)"],
};
