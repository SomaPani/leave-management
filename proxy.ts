import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";

/**
 * Route gate for the organization backbone.
 *
 * Next.js 16 renamed `middleware.ts` to `proxy.ts`; the design doc predates
 * that rename. Same behaviour, and it now runs on the Node.js runtime by
 * default, so reading the Auth.js JWT here is straightforward.
 *
 * This is an *optimistic* check, exactly as the Next docs prescribe: it keeps
 * the wrong role from landing on a page, but it is not the authorization
 * boundary. Every page and route handler re-checks the session through
 * lib/rbac.ts, because a Server Action posts to the page's own path and a
 * matcher change would silently drop coverage.
 *
 * The matcher lists only backbone routes, so the existing leave-management
 * screens and their cookie session are untouched.
 */

const HOME_FOR_ROLE = {
  SUPERADMIN: "/organizations",
  ADMIN: "/approvals",
  MEMBER: "/overview",
} as const;

/** Which roles may see each guarded prefix. */
const ALLOWED: { prefix: string; roles: readonly string[] }[] = [
  { prefix: "/organizations", roles: ["SUPERADMIN"] },
  { prefix: "/admins", roles: ["SUPERADMIN"] },
  { prefix: "/approvals", roles: ["ADMIN"] },
  { prefix: "/attendance", roles: ["ADMIN"] },
  { prefix: "/team", roles: ["ADMIN"] },
  { prefix: "/setup", roles: ["ADMIN"] },
  { prefix: "/scores", roles: ["ADMIN"] },
  { prefix: "/holidays", roles: ["ADMIN"] },
  { prefix: "/members", roles: ["ADMIN"] },
  { prefix: "/profile", roles: ["MEMBER"] },
  { prefix: "/overview", roles: ["MEMBER"] },
  { prefix: "/calendar", roles: ["MEMBER"] },
  { prefix: "/apply", roles: ["MEMBER"] },
  { prefix: "/requests", roles: ["MEMBER"] },
  { prefix: "/score", roles: ["MEMBER"] },
];

export default auth((request) => {
  const { pathname } = request.nextUrl;
  const user = request.auth?.user;

  if (!user) {
    const signIn = new URL("/login", request.nextUrl);
    signIn.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signIn);
  }

  const rule = ALLOWED.find((entry) => pathname.startsWith(entry.prefix));
  if (rule && !rule.roles.includes(user.role)) {
    const home = HOME_FOR_ROLE[user.role as keyof typeof HOME_FOR_ROLE] ?? "/login";
    return NextResponse.redirect(new URL(home, request.nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/approvals/:path*",
    "/attendance/:path*",
    "/team/:path*",
    "/setup/:path*",
    "/scores/:path*",
    "/holidays/:path*",
    "/organizations/:path*",
    "/admins/:path*",
    "/members/:path*",
    "/profile/:path*",
    "/overview/:path*",
    "/calendar/:path*",
    "/apply/:path*",
    "/requests/:path*",
    "/score/:path*",
  ],
};
