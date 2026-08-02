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
  // Added defense-in-depth denylist of file/large-object/network functions.
  it("rejects pg_read_file()", () => {
    expect(validateSql("SELECT pg_read_file('/etc/passwd')")).not.toBeNull();
  });
  it("rejects a schema-qualified pg_read_file() with whitespace before the paren", () => {
    expect(validateSql("SELECT pg_catalog.pg_read_file ('/etc/passwd')")).not.toBeNull();
  });
  it("rejects lo_import()", () => {
    expect(validateSql("SELECT lo_import('/etc/passwd')")).not.toBeNull();
  });
  it("rejects dblink() SSRF", () => {
    expect(
      validateSql("SELECT * FROM dblink('host=169.254.169.254', 'SELECT 1') AS t(x text)"),
    ).not.toBeNull();
  });
  it("rejects pg_ls_dir()", () => {
    expect(validateSql("SELECT pg_ls_dir('.')")).not.toBeNull();
  });
  // False-positive guard: the blocked names as TEXT (not a call) must still work,
  // since this is a vulnerability database whose descriptions mention them.
  it("allows a text search that mentions a blocked function name as a literal", () => {
    expect(
      validateSql("SELECT cve_id FROM nvd_vulnerabilities WHERE description ILIKE '%pg_read_file%'"),
    ).toBeNull();
  });
  it("allows a text search mentioning dblink as a literal", () => {
    expect(
      validateSql("SELECT cve_id FROM nvd_vulnerabilities WHERE description ILIKE '%dblink%'"),
    ).toBeNull();
  });
});

// Blocked-identifier stopgap (the second deliberate deviation). Defense in depth
// behind the app_usage role split — see the comment in sql-utils.ts.
describe("validateSql blocked identifiers", () => {
  it("rejects a bare read of user_usage", () => {
    expect(validateSql("SELECT * FROM user_usage")).not.toBeNull();
  });
  it("rejects it regardless of casing", () => {
    expect(validateSql("select COUNT(*) from USER_USAGE")).not.toBeNull();
  });
  it("rejects a schema-qualified read", () => {
    expect(validateSql("SELECT * FROM public.user_usage")).not.toBeNull();
  });
  it("rejects a quoted identifier", () => {
    expect(validateSql('SELECT * FROM "user_usage"')).not.toBeNull();
  });
  it("rejects it inside a subquery", () => {
    expect(
      validateSql("SELECT cve_id FROM kev_vulnerabilities WHERE 1 IN (SELECT query_count FROM user_usage)"),
    ).not.toBeNull();
  });
  it("rejects it inside a derived table", () => {
    expect(validateSql("SELECT * FROM (SELECT * FROM user_usage) x")).not.toBeNull();
  });
  it("rejects a JOIN against it", () => {
    expect(
      validateSql("SELECT k.cve_id FROM kev_vulnerabilities k JOIN user_usage u ON true"),
    ).not.toBeNull();
  });
  it("rejects the backing sequence", () => {
    expect(validateSql("SELECT last_value FROM user_usage_id_seq")).not.toBeNull();
  });
  it("names the blocked table in the error so the model can explain itself", () => {
    expect(validateSql("SELECT * FROM user_usage")).toContain("user_usage");
  });
  it("rejects unicode-escape syntax, which could spell the name indirectly", () => {
    expect(validateSql('SELECT * FROM U&"user\\5fusage"')).not.toBeNull();
  });
  it("does not reject ordinary corpus queries", () => {
    expect(validateSql("SELECT cve_id FROM kev_vulnerabilities LIMIT 10")).toBeNull();
    expect(validateSql("SELECT * FROM nvd_vulnerabilities WHERE cve_id = 'CVE-2021-44228'")).toBeNull();
    expect(validateSql("SELECT user_interaction FROM nvd_vulnerabilities")).toBeNull();
  });
  it("does not trip on a bitwise & against a quoted literal", () => {
    expect(validateSql("SELECT * FROM etl_runs WHERE flags & '1' = '1'")).toBeNull();
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
