# Deploying to Google Cloud Run

Runbook for deploying vulncopilot-js to Google Cloud Run, using the **existing
Supabase instance** that the reference Python app already populates (the Python
ETL keeps writing to it; this app only reads it, plus `user_usage` writes).

Adapted from the reference repo's
`../vulncopilot/docs/deploy-gcp-cloud-run.md`. Differences that
matter here:

- **Port 3000** (this Dockerfile), not 8080.
- **No `--session-affinity`** — Chainlit needed it for WebSockets; this app
  streams over plain HTTP/SSE, which Cloud Run supports natively.
- **NextAuth needs `AUTH_TRUST_HOST` + `AUTH_URL`** behind Cloud Run's proxy,
  and a production GitHub OAuth app.
- **Node-specific Supabase SSL gotcha** — see [Troubleshooting](#troubleshooting).

Names used throughout (change once, use consistently). `YOUR_PROJECT_ID` is
referenced as the shell variable `$YOUR_PROJECT_ID` in the commands below —
`export` it once (step 1) and the rest of the runbook is copy/paste:

| Placeholder | Meaning |
|---|---|
| `$YOUR_PROJECT_ID` | GCP project id (a string you choose — see step 1) |
| `vulncopilot` | Cloud Run service name |
| `vulncopilot-runner` | Runtime service account |
| `us-central1` | GCP region (Cloud Run) |
| `<project-ref>` | Supabase project reference (from the Supabase dashboard URL) |
| `<supabase-region>` | Supabase project's region, e.g. `us-east-1` — **not** the GCP region |

## Prerequisites

- [Google Cloud CLI (`gcloud`)](https://cloud.google.com/sdk/docs/install)
  installed and authenticated (`gcloud auth login`)
- A billing account you can link to a project (`gcloud billing accounts list`) —
  the project itself is created in step 1
- The existing Supabase project (populated by the Python ETL, with the
  `app_readonly` role from the reference repo's `docs/supabase-readonly-role.md`)
- Podman (optional — only for the local smoke test and build Option B)

## 1. GCP project setup

Pick a project id and export it once — every command below references
`$YOUR_PROJECT_ID`, so this is the only place you type the literal value:

```bash
export YOUR_PROJECT_ID="vulncopilot"   # your chosen id (see rules below)
```

The project **id** is a string you choose: lowercase letters/digits/hyphens,
6–30 chars, **globally unique** across all of GCP, and **immutable** once set.
It is not a UUID and not the numeric project *number* (that's auto-assigned).
If `vulncopilot` is already taken, add a qualifier to the id (e.g.
`vulncopilot-jh`) and keep `--name` clean.

Create the project and link billing (skip the create if you made it in the
Cloud Console — but still `export` the id above and set it as the active config):

```bash
gcloud projects create "$YOUR_PROJECT_ID" --name="vulncopilot"

gcloud billing accounts list                       # copy your billing account id
gcloud billing projects link "$YOUR_PROJECT_ID" \
  --billing-account=XXXXXX-XXXXXX-XXXXXX

gcloud config set project "$YOUR_PROJECT_ID"
```

Billing must be linked before the next step — Cloud Run, Cloud Build, and
Artifact Registry all refuse to enable on an unbilled project.

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com
```

## 2. Runtime service account

Create a dedicated, least-privilege service account for the Cloud Run service:

```bash
gcloud iam service-accounts create vulncopilot-runner \
  --display-name="vulncopilot Cloud Run SA"
```

It needs no project-level roles — secret access is granted per-secret in step 5.

## 3. Supabase prep (existing instance — reuse, don't recreate)

The database, schema, vectors, and roles already exist. This app connects as the
**`app_readonly`** role created per the reference repo's
`docs/supabase-readonly-role.md` (SELECT on the vuln tables, plus INSERT/UPDATE
on `user_usage` for rate limiting).

### Connection string

Use the **transaction pooler (port 6543)**. With Supavisor the username must
carry the project ref suffix (`app_readonly.<project-ref>`) or you get
`Tenant or user not found`:

```
postgresql://app_readonly.<project-ref>:<password>@aws-0-<supabase-region>.pooler.supabase.com:6543/postgres?sslmode=require
```

`<supabase-region>` is your Supabase project's AWS region (e.g. `us-east-1`),
not the GCP region. Rather than hand-assembling the host, copy the exact pooler
host from the Supabase dashboard (Project Settings → Database → Connection
string → **Transaction pooler**) — newer projects use `aws-1-…` and other
prefixes, so the literal value from the dashboard is the safe choice.

node-postgres (`pg`) does not use named prepared statements by default, so the
transaction pooler is safe for this app.

> **SSL mode — `no-verify` now, harden later.** Unlike the Python app's asyncpg,
> node-postgres *verifies* the server cert with `sslmode=require`, so against
> Supabase you'll hit `self-signed certificate in certificate chain` at boot. The
> pragmatic launch value is **`?sslmode=no-verify`** (traffic stays encrypted, cert
> unverified — matching what the Python app effectively did). This is a deliberate,
> deferrable trade-off, **not** a permanent setting: to harden, download the
> Supabase CA cert (Project Settings → Database → SSL), ship it via
> `NODE_EXTRA_CA_CERTS`, and switch back to `?sslmode=require`. See the
> [Troubleshooting](#troubleshooting) row for the exact steps. Whatever you pick,
> the `PG_DATABASE_URL` **secret** (step 5) must carry the matching `sslmode`, or
> the Cloud Run boot fails the same way.

### Verify grants

In the Supabase SQL Editor, confirm `app_readonly` has exactly what the app
needs (SELECT on the four read tables; SELECT/INSERT/UPDATE on `user_usage`):

```sql
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_name IN ('kev_vulnerabilities', 'nvd_vulnerabilities',
                     'cwe_definitions', 'etl_runs', 'user_usage')
  AND grantee = 'app_readonly'
ORDER BY table_name, privilege_type;
```

If anything is missing, follow the reference repo's
`docs/supabase-readonly-role.md` — do not widen grants beyond it.

## 4. Production GitHub OAuth app

With Cloud Run's newer URL format the service URL is deterministic
(`https://<service>-<PROJECT_NUMBER>.<region>.run.app`), so you can register the
OAuth app **before** the first deploy:

```bash
PROJECT_NUMBER=$(gcloud projects describe $YOUR_PROJECT_ID --format="value(projectNumber)")
echo "https://vulncopilot-${PROJECT_NUMBER}.us-central1.run.app"
```

> **If your project is on the legacy URL format** (`https://<service>-<hash>-uc.a.run.app`),
> the hash is not knowable ahead of time. Deploy once (step 8), read the real
> URL from step 9, then register the OAuth app and set `AUTH_URL` to that value.

Create a **new** OAuth app at <https://github.com/settings/developers>
(keep the localhost one for dev):

- **Homepage URL**: `https://vulncopilot-<PROJECT_NUMBER>.us-central1.run.app`
- **Authorization callback URL**:
  `https://vulncopilot-<PROJECT_NUMBER>.us-central1.run.app/api/auth/callback/github`

Note the client id and generate a client secret — they become the
`AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` secrets in step 5.

## 5. Secrets (Secret Manager)

Store every sensitive value in Secret Manager, never in `.env.yaml`:

| Secret | Value |
|---|---|
| `PG_DATABASE_URL` | Supabase `app_readonly` pooler URL from step 3 (embeds the password) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI key (embeddings only — `text-embedding-3-small`) |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_GITHUB_ID` | Production OAuth app client id (step 4) |
| `AUTH_GITHUB_SECRET` | Production OAuth app client secret (step 4) |
| `MCP_API_KEY` | `openssl rand -hex 32` — **required**: if unset, `/api/mcp` serves unauthenticated |

Create each one and grant the runtime SA access (prompts for the value so it
never lands in shell history):

```bash
for s in PG_DATABASE_URL ANTHROPIC_API_KEY OPENAI_API_KEY \
         AUTH_SECRET AUTH_GITHUB_ID AUTH_GITHUB_SECRET MCP_API_KEY; do
  printf "Enter value for %s: " "$s"; IFS= read -rs v; echo
  printf '%s' "$v" | gcloud secrets create "$s" --data-file=-
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:vulncopilot-runner@$YOUR_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

Update a value later (then see [Redeploying](#8-redeploying)):

```bash
echo -n "new-value" | gcloud secrets versions add SECRET_NAME --data-file=-
```

**Optional — Langfuse tracing.** To export agent/LLM/tool traces, add
`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` as two more secrets (same
create + IAM-binding loop above, and add them to `--set-secrets` in step 8).
Tracing stays off unless **both** are set; setting only one boots with tracing
disabled and a warning. `LANGFUSE_BASE_URL` is non-secret (defaults to Langfuse
US cloud) — put it in `.env.yaml` only if you use the EU region or a self-hosted
instance.

## 6. Non-secret environment variables

Write `.env.yaml` by hand (already gitignored via the `.env*` pattern). List
vars use the JSON-array convention — a bare `a,b` fails zod validation at boot.

```yaml
# NextAuth behind Cloud Run's proxy — both REQUIRED.
# AUTH_URL is the *.run.app URL for a bare Cloud Run deploy. Once the app is
# behind a custom domain (see custom-domain-cloudflare.md), set AUTH_URL to that
# domain instead (e.g. https://vulncopilot.org) and update the GitHub OAuth
# callback to match.
AUTH_TRUST_HOST: "true"
AUTH_URL: "https://vulncopilot-<PROJECT_NUMBER>.us-central1.run.app"

# Models. EMBEDDING_MODEL is pinned to the vectors already in Supabase —
# changing it silently breaks cosine search.
LLM_MODEL: "claude-sonnet-5"
LLM_EFFORT: "low"
EMBEDDING_MODEL: "text-embedding-3-small"

# RAG / chat
TOP_K: "5"
MAX_HISTORY_MESSAGES: "50"
ACTION_BUTTONS: '["List the 10 newest KEV entries by date_added","List KEV entries with known ransomware use","CVE-2021-44228 (Log4Shell)","Top vendors in KEV","Which weakness types appear most in KEV?"]'

# Authorization (allow-list; JSON arrays)
OPEN_REGISTRATION: "false"
ALLOWED_LOGINS: '["jeffhoek"]'
# ALLOWED_EMAILS: '["alice@example.com"]'
# ALLOWED_EMAIL_DOMAINS: '["mycompany.com"]'

# Rate limiting + /admin access (stable github:<id> keys)
ADMIN_USER_IDENTIFIERS: '["github:12345678"]'
DAILY_QUERY_LIMIT: "20"
ADMIN_DAILY_QUERY_LIMIT: "100000"

# /admin cost estimate (USD per million tokens)
LLM_INPUT_COST_PER_MILLION: "3.00"
LLM_OUTPUT_COST_PER_MILLION: "15.00"
```

## 7. Local smoke test against Supabase (do this before deploying)

Catches the two most likely failures — Supabase SSL trust and role grants —
while you still have a fast feedback loop. Point a local container at the real
Supabase URL (use a throwaway env file with the production `PG_DATABASE_URL`
and your dev OAuth/app keys; don't commit it):

```bash
podman build -t vulncopilot:local .
podman run --rm -p 3000:3000 --env-file /path/to/smoke.env vulncopilot:local
```

Then in another terminal:

```bash
curl -sf http://localhost:3000/ >/dev/null && echo "boot OK"
```

Sign in and run a query (e.g. "List the 10 newest KEV entries"). If boot fails
with an SSL or `Tenant or user not found` error, fix it now — see
[Troubleshooting](#troubleshooting).

## 8. Deploy

### Option A — Cloud Build from source (recommended)

Cloud Build uses the repo's Dockerfile. `gcloud` derives `.gcloudignore` from
`.gitignore`, so `.env*` files are never uploaded.

```bash
PROJECT_NUMBER=$(gcloud projects describe $YOUR_PROJECT_ID --format="value(projectNumber)")

gcloud run deploy vulncopilot \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 3000 \
  --memory 1Gi \
  --timeout 300 \
  --min-instances 0 \
  --max-instances 3 \
  --env-vars-file .env.yaml \
  --build-service-account "projects/$YOUR_PROJECT_ID/serviceAccounts/${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --set-secrets="PG_DATABASE_URL=PG_DATABASE_URL:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,AUTH_SECRET=AUTH_SECRET:latest,AUTH_GITHUB_ID=AUTH_GITHUB_ID:latest,AUTH_GITHUB_SECRET=AUTH_GITHUB_SECRET:latest,MCP_API_KEY=MCP_API_KEY:latest" \
  --service-account vulncopilot-runner@$YOUR_PROJECT_ID.iam.gserviceaccount.com
```

Key flags:

| Flag | Purpose |
|---|---|
| `--port 3000` | Matches the Dockerfile (`EXPOSE 3000`); Cloud Run injects `PORT=3000`, which the standalone `server.js` reads |
| `--allow-unauthenticated` | Public URL — the app enforces its own GitHub OAuth + allow-list |
| `--timeout 300` | Headroom for long streamed agent responses |
| `--min-instances 0` | Scale to zero when idle |
| No `--session-affinity` | Deliberate: streaming is plain HTTP/SSE, no WebSockets (unlike the Chainlit reference) |

### Option B — build locally with podman, push to Artifact Registry

Useful if Cloud Build misbehaves or you want to ship the exact image you
smoke-tested.

```bash
# One-time: image repo + registry login
gcloud artifacts repositories create vulncopilot \
  --repository-format=docker --location=us-central1
podman login -u oauth2accesstoken -p "$(gcloud auth print-access-token)" \
  us-central1-docker.pkg.dev

# Build for amd64 — REQUIRED on Apple Silicon (default arm64 images fail on
# Cloud Run with "exec format error")
podman build --platform linux/amd64 \
  -t us-central1-docker.pkg.dev/$YOUR_PROJECT_ID/vulncopilot/vulncopilot:latest .
podman push us-central1-docker.pkg.dev/$YOUR_PROJECT_ID/vulncopilot/vulncopilot:latest
```

Then deploy with `--image us-central1-docker.pkg.dev/$YOUR_PROJECT_ID/vulncopilot/vulncopilot:latest`
in place of `--source .` (and drop `--build-service-account`) in the Option A
command.

## 9. Verify

```bash
gcloud run services describe vulncopilot \
  --region us-central1 --format="value(status.url)"
```

Walk the full surface:

1. **Boot** — the URL loads the sign-in page. If the revision fails to start,
   check logs first (zod config validation fails fast at boot and prints every
   missing/invalid var):

   ```bash
   gcloud run services logs read vulncopilot --region us-central1 --limit 50
   ```

2. **Auth** — sign in with an allow-listed GitHub account; confirm a
   non-allow-listed account is denied.
3. **Chat** — run a query ("List the 10 newest KEV entries by date_added");
   the response should **stream** token-by-token and answer from KEV/NVD data.
4. **Rate limiting** — in the Supabase SQL Editor:

   ```sql
   SELECT * FROM user_usage ORDER BY query_date DESC, id DESC LIMIT 5;
   ```

   A row for your `github:<id>` with an incremented `query_count` proves the
   `app_readonly` write path works.
5. **Admin** — `/admin` loads for `ADMIN_USER_IDENTIFIERS` accounts and is
   denied for others.
6. **MCP** — confirm the `x-api-key` gate. Without a key the endpoint returns
   401; with a valid key it does **not** (the transport takes over):

   ```bash
   URL=$(gcloud run services describe vulncopilot --region us-central1 --format="value(status.url)")
   curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/api/mcp"        # expect 401
   ```

   `/api/mcp` speaks MCP **streamable-HTTP**, not plain JSON-RPC: a `tools/list`
   call must send `Accept: application/json, text/event-stream` and follow an
   `initialize` handshake (the server issues an `Mcp-Session-Id` that later
   requests echo back), so a bare one-liner won't return a clean 200. Drive it
   with a real MCP client (e.g. `npx @modelcontextprotocol/inspector`) pointed
   at `$URL/api/mcp` with the `x-api-key` header, and confirm `query` +
   `retrieve` are listed. The key check above is the deploy-time smoke test.

## 10. Redeploying

After code changes, rerun the step-8 deploy command — Cloud Build creates a new
revision.

Secrets are resolved at instance start (`:latest`), so after rotating a secret
force a new revision:

```bash
echo -n "new-value" | gcloud secrets versions add SECRET_NAME --data-file=-
gcloud run services update vulncopilot --region us-central1
```

Non-secret config changes: edit `.env.yaml` and rerun the deploy command (or
`gcloud run services update vulncopilot --region us-central1 --env-vars-file .env.yaml`).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `UntrustedHost` error from NextAuth | `AUTH_TRUST_HOST=true` missing from `.env.yaml`. Required for any deploy behind a proxy. |
| GitHub sign-in redirects to the wrong host or loops | `AUTH_URL` doesn't match the service URL, or the OAuth app callback URL is wrong. Both must be the exact Cloud Run URL. |
| `self-signed certificate in certificate chain` at boot | node-postgres verifies certs where the Python app's asyncpg (`sslmode=require`) did not. Preferred: download the CA cert from the Supabase dashboard (Project Settings → Database → SSL), ship it in the image or a mounted secret, and set `NODE_EXTRA_CA_CERTS=/path/to/prod-ca.crt`. Pragmatic fallback: `?sslmode=no-verify` in `PG_DATABASE_URL` — traffic stays encrypted but the cert is unverified (libpq `require` semantics, i.e. what the Python app was effectively doing). |
| `Tenant or user not found` / `XX000` from Supabase | Pooler username missing the project-ref suffix — must be `app_readonly.<project-ref>`. |
| `password authentication failed` for `app_readonly` despite correct password | Supavisor didn't sync the credential. Run `ALTER ROLE app_readonly PASSWORD '<same-password>';` in the SQL Editor. |
| Revision fails: `exec format error` | arm64 image (Apple Silicon default). Rebuild with `--platform linux/amd64` (Option B) or use Cloud Build (Option A). |
| Boot fails: `Invalid environment configuration` | zod fail-fast — the log lists each bad var. Most common: list vars (`ALLOWED_*`, `ADMIN_USER_IDENTIFIERS`, `ACTION_BUTTONS`) not valid JSON arrays. |
| Cloud Build fails on `--mount=type=cache` | Builder without BuildKit. The cache mount in the Dockerfile is an optimization only — remove it and rebuild. |
| Chat answers but `permission denied for table user_usage` in logs | Missing `INSERT`/`UPDATE` grant (or sequence grant) for `app_readonly` — step 3 verify query, then reference `docs/supabase-readonly-role.md` step 6.5. |

## Cleanup

```bash
gcloud run services delete vulncopilot --region us-central1
```

Remove container images (Option A images land in `cloud-run-source-deploy`;
Option B in the `vulncopilot` repo):

```bash
gcloud artifacts docker images list \
  us-central1-docker.pkg.dev/$YOUR_PROJECT_ID/cloud-run-source-deploy \
  --format="value(IMAGE)" | while read -r image; do
  gcloud artifacts docker images delete "$image" --quiet
done
```

Secrets, the service account, and the Supabase instance (shared with the ETL)
are left in place.
