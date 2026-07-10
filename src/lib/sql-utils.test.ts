import { describe, expect, it } from "vitest";
import {
  MAX_CELL_CHARS,
  applyRowLimit,
  formatQueryResults,
  validateSql,
} from "./sql-utils";

// Ported from reference tests/unit/test_sql_utils.py, plus multi-statement cases.

describe("validateSql", () => {
  it("accepts a SELECT", () => {
    expect(validateSql("SELECT * FROM t")).toBeNull();
  });
  it("accepts lowercase select", () => {
    expect(validateSql("select * from t")).toBeNull();
  });
  it("accepts leading whitespace", () => {
    expect(validateSql("  SELECT * FROM t")).toBeNull();
  });
  it("accepts a single trailing semicolon", () => {
    expect(validateSql("SELECT * FROM t;")).toBeNull();
    expect(validateSql("SELECT * FROM t;  ")).toBeNull();
  });
  it("rejects DROP TABLE", () => {
    expect(validateSql("DROP TABLE t")).not.toBeNull();
  });
  it("rejects INSERT", () => {
    expect(validateSql("INSERT INTO t VALUES (1)")).not.toBeNull();
  });
  it("rejects empty string", () => {
    expect(validateSql("")).not.toBeNull();
  });
  // Added multi-statement cases (the deliberate deviation from the reference).
  it("rejects a stacked statement after a SELECT", () => {
    expect(validateSql("SELECT 1; DELETE FROM t")).not.toBeNull();
  });
  it("rejects two SELECTs", () => {
    expect(validateSql("SELECT 1; SELECT 2")).not.toBeNull();
  });
  it("rejects a stacked statement with a trailing semicolon", () => {
    expect(validateSql("SELECT 1; DROP TABLE t;")).not.toBeNull();
  });
});

describe("applyRowLimit", () => {
  it("injects LIMIT when absent", () => {
    expect(applyRowLimit("SELECT * FROM t", 100)).toBe("SELECT * FROM t LIMIT 100");
  });
  it("strips a trailing semicolon before injecting", () => {
    expect(applyRowLimit("SELECT * FROM t;", 100)).toBe("SELECT * FROM t LIMIT 100");
  });
  it("leaves LIMIT unchanged when within max", () => {
    expect(applyRowLimit("SELECT * FROM t LIMIT 10", 100)).toBe(
      "SELECT * FROM t LIMIT 10",
    );
  });
  it("rewrites a LIMIT exceeding the default max", () => {
    const result = applyRowLimit("SELECT * FROM t LIMIT 500", 100);
    expect(result).toContain("LIMIT 100");
    expect(result).not.toContain("LIMIT 500");
  });
  it("rewrites a LIMIT exceeding a custom max", () => {
    const result = applyRowLimit("SELECT * FROM t LIMIT 500", 200);
    expect(result).toContain("LIMIT 200");
    expect(result).not.toContain("LIMIT 500");
  });
});

describe("formatQueryResults", () => {
  it("contains headers, data, and row count", () => {
    const result = formatQueryResults([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    expect(result).toContain("id");
    expect(result).toContain("name");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    expect(result).toContain("2 row(s) returned.");
  });
  it("truncates long cell values", () => {
    const longValue = "x".repeat(MAX_CELL_CHARS + 50);
    const result = formatQueryResults([{ col: longValue }]);
    expect(result).toContain("…");
    expect(result).not.toContain(longValue);
  });
  it("appends a truncation notice when output too large", () => {
    const rows = Array.from({ length: 300 }, () => ({ col: "x".repeat(100) }));
    const result = formatQueryResults(rows, MAX_CELL_CHARS, 1000);
    expect(result).toContain("[Output truncated");
  });
  it("no truncation notice when output within limit", () => {
    const result = formatQueryResults([{ id: 1 }]);
    expect(result).not.toContain("[Output truncated");
  });
  it("expands list values one per line", () => {
    const urls = [
      "https://nvd.nist.gov/vuln/detail/CVE-2026-25253",
      "https://github.com/openclaw/openclaw/security/advisories/GHSA-xxxx-xxxx-xxxx",
    ];
    const result = formatQueryResults([{ reference_urls: urls }]);
    expect(result).toContain(urls[0]);
    expect(result).toContain(urls[1]);
  });
  it("truncates long list elements individually", () => {
    const longUrl = "https://example.com/" + "a".repeat(MAX_CELL_CHARS + 10);
    const shortUrl = "https://example.com/short";
    const result = formatQueryResults([{ reference_urls: [longUrl, shortUrl] }]);
    expect(result).toContain(shortUrl);
    expect(result).not.toContain(longUrl);
    expect(result).toContain("…");
  });
});
