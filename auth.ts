import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { config } from "@/src/lib/config";
import { decideAccess, type GitHubProfile } from "@/src/lib/auth-allowlist";

// NextAuth v5 (Auth.js), GitHub provider, JWT sessions (no DB adapter — the
// shared DB is read-mostly and owns no auth tables; see CLAUDE.md / IMPLEMENTATION
// Phase 3). Replaces the reference Chainlit `oauth_callback` allow-list gate.
//
// GitHub client id/secret and AUTH_SECRET are read from env by NextAuth's own
// convention (AUTH_GITHUB_ID / AUTH_GITHUB_SECRET / AUTH_SECRET).
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  // Redirect unauthenticated / denied users to the app root, which renders the
  // sign-in view. On a denied sign-in NextAuth appends `?error=AccessDenied`.
  pages: { signIn: "/", error: "/" },
  // Session lifetime is the ONLY revocation lever this app has: JWT sessions
  // carry no server-side session store (no DB adapter — see above), so removing
  // someone from the allow-list does not sign them out. Their token stays valid
  // until it expires. NextAuth's 30-day default is far too long for a
  // domain-wide allow-list, where "revoke access" must actually mean something
  // (an ex-employee keeps a verified company address on their GitHub account).
  // Default 24h; tune with SESSION_MAX_AGE_SECONDS.
  session: { strategy: "jwt", maxAge: config.SESSION_MAX_AGE_SECONDS },
  callbacks: {
    // The allow-list gate. Ported branching lives in decideAccess() (unit-tested).
    signIn({ profile }) {
      if (!profile) return false;
      const gh: GitHubProfile = {
        id: profile.id as string | number,
        login: (profile.login as string | undefined) ?? "",
        email: (profile.email as string | undefined) ?? "",
      };
      const decision = decideAccess(gh, {
        openRegistration: config.OPEN_REGISTRATION,
        allowedEmails: config.ALLOWED_EMAILS,
        allowedEmailDomains: config.ALLOWED_EMAIL_DOMAINS,
        allowedLogins: config.ALLOWED_LOGINS,
      });
      if (!decision.allowed) {
        // Mirrors reference: log the denied identity (login + email), deny.
        console.warn(`OAuth denied: login=${gh.login} email=${gh.email}`);
        return false;
      }
      return true;
    },
    // Stamp the stable identity key on the token at initial sign-in (profile is
    // only present then), then surface it on the session.
    jwt({ token, profile }) {
      if (profile) token.userId = `github:${profile.id}`;
      return token;
    },
    session({ session, token }) {
      if (token.userId) session.userId = token.userId;
      return session;
    },
  },
});
