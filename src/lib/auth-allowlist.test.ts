import { describe, expect, it } from "vitest";
import { decideAccess, type AllowListConfig } from "./auth-allowlist";

// Port of reference `tests/unit/test_oauth_callback.py`. Each test starts from a
// locked-shut allow-list and opts into exactly one path, mirroring the reference's
// `_reset` fixture.
const LOCKED: AllowListConfig = {
  openRegistration: false,
  allowedEmails: [],
  allowedEmailDomains: [],
  allowedLogins: [],
};

describe("decideAccess (port of oauth_callback allow-list)", () => {
  it("open registration allows anyone", () => {
    const d = decideAccess(
      { id: 12345678, login: "randomuser", email: "nobody@nowhere.io" },
      { ...LOCKED, openRegistration: true },
    );
    expect(d.allowed).toBe(true);
    expect(d.userId).toBe("github:12345678");
  });

  it("allowed exact email matches", () => {
    const d = decideAccess(
      { id: 42, login: "alice", email: "alice@example.com" },
      { ...LOCKED, allowedEmails: ["alice@example.com"] },
    );
    expect(d.allowed).toBe(true);
    expect(d.userId).toBe("github:42");
  });

  it("allowed email domain matches", () => {
    const d = decideAccess(
      { id: 7, login: "bob", email: "bob@mycompany.com" },
      { ...LOCKED, allowedEmailDomains: ["mycompany.com"] },
    );
    expect(d.allowed).toBe(true);
    expect(d.userId).toBe("github:7");
  });

  it("allowed login matches; identity is the numeric id, not the login", () => {
    const d = decideAccess(
      { id: 99, login: "jeffhoek", email: "" },
      { ...LOCKED, allowedLogins: ["jeffhoek"] },
    );
    expect(d.allowed).toBe(true);
    expect(d.userId).toBe("github:99");
  });

  it("denies a user matching no rule", () => {
    const d = decideAccess(
      { id: 1, login: "intruder", email: "intruder@evil.com" },
      { ...LOCKED, allowedLogins: ["jeffhoek"] },
    );
    expect(d.allowed).toBe(false);
  });

  it("an empty email is not coerced into a domain match", () => {
    const d = decideAccess(
      { id: 2, login: "ghost", email: "" },
      { ...LOCKED, allowedEmailDomains: ["mycompany.com"] },
    );
    expect(d.allowed).toBe(false);
  });
});
