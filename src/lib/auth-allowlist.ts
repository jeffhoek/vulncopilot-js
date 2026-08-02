// Pure allow-list decision, ported verbatim from the reference
// `app.py::oauth_callback` branching. Kept framework-free so it is unit-testable
// without NextAuth (see auth-allowlist.test.ts, a port of
// reference `tests/unit/test_oauth_callback.py`). The NextAuth `signIn` callback
// in `auth.ts` is a thin wrapper around this.

export interface GitHubProfile {
  // GitHub's stable numeric account id (never changes on rename). Number over
  // the wire; accepted as string too for safety.
  id: string | number;
  // GitHub username — MUTABLE, used only for allow-list matching, never as the
  // identity key.
  login: string;
  // Public email if the account exposes one; "" otherwise.
  email: string;
}

export interface AllowListConfig {
  openRegistration: boolean;
  allowedEmails: string[];
  allowedEmailDomains: string[];
  allowedLogins: string[];
}

export interface AllowDecision {
  allowed: boolean;
  // Stable identity key `github:<id>` — always the numeric id, never the login
  // or email (reference app.py:95). Present regardless of the decision so the
  // caller can log a denied identity.
  userId: string;
}

// FLAGGED DIVERGENCE from the reference: matching here is case-INSENSITIVE.
// The reference compares raw strings, which silently denies `Jeff@Company.org`
// against an allow-list entry of `company.org`. Email domains are case-insensitive
// per RFC 1035, GitHub logins are case-insensitive, and GitHub returns whatever
// casing the account holder typed — so a case-sensitive compare produces denials
// that look like outages. Local-parts are technically case-sensitive per RFC 5321
// but no real provider treats them that way; folding them matches operator intent.
// Both sides are folded so the decision is correct regardless of how the caller
// spelled the env vars.
const fold = (s: string): string => s.trim().toLowerCase();

// Mirrors reference `app.py::oauth_callback` exactly, in the same order:
//   open_registration → allowed_emails → allowed_email_domains → allowed_logins.
// A missing (empty) email must never match an email/domain rule (reference guards
// each email branch with `if email and …`).
export function decideAccess(profile: GitHubProfile, cfg: AllowListConfig): AllowDecision {
  const email = fold(profile.email ?? "");
  const login = fold(profile.login ?? "");
  const userId = `github:${profile.id}`;

  if (cfg.openRegistration) return { allowed: true, userId };
  if (email && cfg.allowedEmails.some((e) => fold(e) === email)) return { allowed: true, userId };
  if (email && cfg.allowedEmailDomains.some((d) => email.endsWith(`@${fold(d)}`)))
    return { allowed: true, userId };
  if (login && cfg.allowedLogins.some((l) => fold(l) === login)) return { allowed: true, userId };

  return { allowed: false, userId };
}
