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
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // "/" listed explicitly — the pattern below does not match the bare root path,
  // which left the Home route unguarded under basePath (verified 2026-08-10).
  matcher: ["/", "/((?!_next/static|_next/image|favicon.ico).*)"],
};
