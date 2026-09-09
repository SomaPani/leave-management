import NextAuth, { type NextAuthConfig } from "next-auth";
// Imported so the `declare module "next-auth/jwt"` augmentation below can
// resolve the module it is extending.
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";

import type { Role } from "@/generated/prisma/enums";
import { verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/rbac";

/**
 * Auth.js (NextAuth v5) configured for email + password sign-in.
 *
 * The Credentials provider requires the JWT session strategy — there is no
 * database session row to look up — so `role` and `organizationId` are baked
 * into the token at sign-in. That's what lets proxy.ts authorize a request
 * without a database round-trip.
 *
 * Note there is no Prisma *adapter* here. An adapter stores OAuth accounts and
 * database sessions; with Credentials + JWT neither exists, so wiring one up
 * would only add Auth.js's unused `Account` / `Session` / `VerificationToken`
 * tables. Users are still read from Postgres via Prisma — just directly, in
 * `authorize` below.
 */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
      role: Role;
      organizationId: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid: string;
    role: Role;
    organizationId: string | null;
  }
}

/** What `authorize` returns, and therefore what the `jwt` callback receives. */
type AuthorizedUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  organizationId: string | null;
};

function readCredential(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export const authConfig: NextAuthConfig = {
  // Auth.js v5 reads AUTH_SECRET; the design names it NEXTAUTH_SECRET, so
  // accept either.
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  // Self-hosted behind Docker/localhost rather than on a known deployment host.
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = readCredential(credentials?.email).toLowerCase();
        const password = readCredential(credentials?.password);
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
          // Hash anyway so a missing account and a wrong password take
          // comparable time, rather than making accounts enumerable.
          await verifyPassword(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi");
          return null;
        }

        if (!(await verifyPassword(password, user.passwordHash))) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          organizationId: user.organizationId,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }): JWT {
      // `user` is only present on the sign-in pass; later calls just re-read
      // the token, which is why role and org have to be baked in here.
      if (user) {
        const authorized = user as AuthorizedUser;
        token.uid = authorized.id;
        token.role = authorized.role;
        token.organizationId = authorized.organizationId;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.uid;
      session.user.role = token.role;
      session.user.organizationId = token.organizationId;
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

/**
 * The current caller as the policy layer wants them, or `null` when signed out.
 *
 * Read from the JWT, so this is cheap enough to call in every guarded page and
 * route handler.
 */
export async function currentActor(): Promise<Actor | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    role: session.user.role,
    organizationId: session.user.organizationId,
  };
}
