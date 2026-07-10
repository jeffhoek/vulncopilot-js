// Carry the stable identity key (`github:<id>`) on the session and JWT. This is
// the authoritative per-user identifier used everywhere downstream (rate limiting,
// admin gating) — never the mutable login/email.
import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    userId?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
  }
}
