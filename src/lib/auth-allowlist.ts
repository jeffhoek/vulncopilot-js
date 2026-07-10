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

// Mirrors reference `app.py::oauth_callback` exactly, in the same order:
//   open_registration → allowed_emails → allowed_email_domains → allowed_logins.
// A missing (empty) email must never match an email/domain rule (reference guards
// each email branch with `if email and …`).
export function decideAccess(profile: GitHubProfile, cfg: AllowListConfig): AllowDecision {
  const email = profile.email ?? "";
  const login = profile.login ?? "";
  const userId = `github:${profile.id}`;

  if (cfg.openRegistration) return { allowed: true, userId };
  if (email && cfg.allowedEmails.includes(email)) return { allowed: true, userId };
  if (email && cfg.allowedEmailDomains.some((d) => email.endsWith(`@${d}`)))
    return { allowed: true, userId };
  if (login && cfg.allowedLogins.includes(login)) return { allowed: true, userId };

  return { allowed: false, userId };
}
