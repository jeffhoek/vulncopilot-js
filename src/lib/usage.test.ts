import { describe, expect, it } from "vitest";
import { limitFor, limitMessage, type RateLimitConfig } from "./usage";

// Port of reference `tests/unit/test_rate_limit.py`. Covers the pure per-user
// effective-limit boundary logic. checkAndIncrement / currentDailyCount hit the
// live DB and are exercised by the Phase 4 manual verification (DoD), matching
// the reference, which likewise unit-tests only `_limit_for`.

const BASE: RateLimitConfig = {
  dailyQueryLimit: 20,
  adminDailyQueryLimit: 100000,
  adminUserIdentifiers: [],
};

describe("limitFor (port of app._limit_for)", () => {
  it("default user gets the standard limit", () => {
    const cfg = { ...BASE, adminUserIdentifiers: ["github:111"] };
    expect(limitFor("github:999", cfg)).toBe(20);
  });

  it("admin identifier gets the elevated limit", () => {
    const cfg = { ...BASE, adminUserIdentifiers: ["github:111", "github:222"] };
    expect(limitFor("github:222", cfg)).toBe(100000);
  });

  it("empty admin list means everyone gets the standard limit", () => {
    const cfg = { ...BASE, dailyQueryLimit: 5, adminUserIdentifiers: [] };
    expect(limitFor("github:111", cfg)).toBe(5);
  });
});

describe("limitMessage (port of app._limit_message)", () => {
  it("renders the verbatim daily-limit message", () => {
    expect(limitMessage(2)).toBe(
      "You've reached your daily limit of 2 queries. Try again tomorrow.",
    );
  });
});
