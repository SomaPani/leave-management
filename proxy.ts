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
  ADMIN: "/members",
  MEMBER: "/account",
} as const;

/** Which roles may see each guarded prefix. */
const ALLOWED: { prefix: string; roles: readonly string[] }[] = [
  { prefix: "/organizations", roles: ["SUPERADMIN"] },
  { prefix: "/admins", roles: ["SUPERADMIN"] },
  { prefix: "/members", roles: ["ADMIN"] },
  { prefix: "/account", roles: ["MEMBER"] },
];

export default auth((request) => {
  const { pathname } = request.nextUrl;
  const user = request.auth?.user;

  if (!user) {
    const signIn = new URL("/signin", request.nextUrl);
    signIn.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signIn);
  }

  const rule = ALLOWED.find((entry) => pathname.startsWith(entry.prefix));
  if (rule && !rule.roles.includes(user.role)) {
    const home = HOME_FOR_ROLE[user.role as keyof typeof HOME_FOR_ROLE] ?? "/signin";
    return NextResponse.redirect(new URL(home, request.nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/organizations/:path*",
    "/admins/:path*",
    "/members/:path*",
    "/account/:path*",
  ],
};
