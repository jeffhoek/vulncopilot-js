-- Least-privilege Postgres role for the vulncopilot-js app (SECURITY-REVIEW F2).
--
-- WHY: the `query` tool executes LLM-generated SELECTs. `SET TRANSACTION READ
-- ONLY` and the app-side denylist (src/lib/sql-utils.ts) reduce risk, but the
-- AUTHORITATIVE boundary is this role's privileges. Connect the app as a role
-- that is NOT a superuser, cannot read server files, and can touch only the
-- tables it needs. Then a prompt-injected SELECT cannot read /etc/passwd, dump
-- credential catalogs, or reach the network (dblink/SSRF).
--
-- HOW TO RUN: as the database owner / a superuser, against the app database:
--   psql "$ADMIN_DATABASE_URL" -v app_password="'choose-a-strong-password'" \
--        -f db/least-privilege-role.sql
-- Then point PG_DATABASE_URL at this role. Verify with:
--   SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'vulncopilot_app';
--   -- all three must be false; the app also warns at boot if it connects as a superuser.
--
-- NOTE: the app is READ-MOSTLY. It only WRITES to user_usage (rate-limit
-- accounting). Everything else is SELECT-only. The ETL pipeline (separate repo)
-- owns DDL and keeps its own, more-privileged role.

-- 1) The role: login-capable, but explicitly stripped of every elevated attribute.
--    (Re-running is safe: CREATE ROLE errors if it exists — drop/alter as needed.)
CREATE ROLE vulncopilot_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Ensure no elevated group memberships (harmless if not present). These roles
-- are exactly what would re-open the F2 hole, so deny them explicitly.
REVOKE pg_read_server_files    FROM vulncopilot_app;
REVOKE pg_write_server_files   FROM vulncopilot_app;
REVOKE pg_execute_server_program FROM vulncopilot_app;
REVOKE pg_read_all_data        FROM vulncopilot_app;
REVOKE pg_write_all_data       FROM vulncopilot_app;

-- 2) Connect + schema usage, but no object creation.
GRANT CONNECT ON DATABASE CURRENT_CATALOG TO vulncopilot_app;
GRANT USAGE ON SCHEMA public TO vulncopilot_app;
REVOKE CREATE ON SCHEMA public FROM vulncopilot_app;

-- 3) Read-only on the corpus + ETL history (the only tables the app reads).
GRANT SELECT ON
  kev_vulnerabilities,
  nvd_vulnerabilities,
  cwe_definitions,
  etl_runs
TO vulncopilot_app;

-- 4) The one table the app writes: rate-limit accounting (INSERT ... ON CONFLICT
--    DO UPDATE ... RETURNING). Needs SELECT + INSERT + UPDATE, not DELETE.
GRANT SELECT, INSERT, UPDATE ON user_usage TO vulncopilot_app;
-- If user_usage.id (or similar) is a SERIAL/IDENTITY, the INSERT needs its sequence:
-- GRANT USAGE ON SEQUENCE user_usage_id_seq TO vulncopilot_app;

-- 5) Deliberately NOT granted: any other table, EXECUTE on dblink/lo_* functions,
--    and membership in the pg_read_server_files role. Do not add them.
