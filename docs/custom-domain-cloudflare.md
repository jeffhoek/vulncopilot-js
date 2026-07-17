# Pointing `vulncopilot.org` (Cloudflare DNS) at Cloud Run

Runbook for putting the deployed Cloud Run service (see
[`deploy-gcp-cloud-run.md`](./deploy-gcp-cloud-run.md)) behind the apex domain
**`vulncopilot.org`**, whose DNS is managed in Cloudflare.

The app has **no hardcoded hosts, no CSP/CORS/cookie-domain pins, and `/api/mcp`
is host-agnostic**. The only host-dependent behavior is NextAuth, driven entirely
by two env vars (`AUTH_URL`, `AUTH_TRUST_HOST`) plus the GitHub OAuth app's
callback URL. So this cutover is almost all DNS/TLS/Cloud Run infra plus two small
config changes.

Approach (chosen for simplicity and lowest cost):

| Decision | Choice | Why |
|---|---|---|
| Canonical host | apex `vulncopilot.org` | `AUTH_URL=https://vulncopilot.org`; `www` optionally redirects to it |
| Cloudflare mode | **DNS-only** (grey cloud) | TLS terminates at Google, traffic goes direct to Cloud Run — fewest gotchas |
| Origin method | **Cloud Run domain mapping** | Free, Google-managed TLS cert, minimal setup |

Names carried over from the deploy runbook:

| Placeholder | Meaning |
|---|---|
| `$YOUR_PROJECT_ID` | GCP project id (`export` it, as in the deploy runbook) |
| `vulncopilot` | Cloud Run service name |
| `us-central1` | GCP region |
| `vulncopilot.org` | The apex domain (Cloudflare-managed DNS) |

## Prerequisites

- A working Cloud Run deploy — the [`deploy-gcp-cloud-run.md`](./deploy-gcp-cloud-run.md)
  step-8 deploy, reachable at its `*.run.app` URL.
- `vulncopilot.org` active in Cloudflare (nameservers already delegated to
  Cloudflare; the zone resolves).
- `gcloud` authenticated and the project set (`gcloud config set project "$YOUR_PROJECT_ID"`).

> **Zero-downtime note up front.** The `*.run.app` URL keeps working through this
> whole process. Nothing breaks until you flip `AUTH_URL` + the OAuth callback in
> steps 5–6, and those come *after* the domain is live and its cert is active.

## 1. Verify domain ownership with Google (one-time)

Cloud Run domain mappings require the domain to be verified for your Google
account:

```bash
gcloud domains verify vulncopilot.org
```

This opens Google Search Console and gives you a `TXT` record. Add it in
Cloudflare (DNS → Records; proxy status is irrelevant for `TXT`), then confirm
verification. The account creating the mapping in step 2 must be a verified owner.

## 2. Create the Cloud Run domain mapping

```bash
gcloud beta run domain-mappings create \
  --service vulncopilot \
  --domain vulncopilot.org \
  --region us-central1
```

For an **apex** domain this returns a set of **`A` + `AAAA`** records pointing at
Google's front-end IPs. Re-print the records and watch cert status any time with:

```bash
gcloud beta run domain-mappings describe \
  --domain vulncopilot.org --region us-central1
```

> `domain-mappings` is a `gcloud beta` surface and is region-limited; `us-central1`
> is supported. If the command reports the feature is unavailable in your region,
> use an External HTTPS Load Balancer instead (see Troubleshooting).

## 3. Add the DNS records in Cloudflare (DNS-only)

In the Cloudflare dashboard (DNS → Records), add **every** `A` and `AAAA` record
from step 2, exactly as given:

- **Proxy status: DNS only (grey cloud).** This is required — Google validates and
  serves its managed certificate by reaching its own IPs directly, which the orange
  proxy would intercept. Do **not** enable proxying.
- TTL: Auto.

Cloudflare supports `A`/`AAAA` records at the apex natively, so no CNAME flattening
is needed.

## 4. Wait for TLS certificate provisioning

Once the records resolve to Google's IPs, Cloud Run auto-provisions a managed
certificate for `vulncopilot.org`. This takes anywhere from ~15 minutes to 24
hours (usually well under an hour).

Check progress:

```bash
gcloud beta run domain-mappings describe \
  --domain vulncopilot.org --region us-central1 \
  --format="value(status.conditions)"

# or just hit it:
curl -sI https://vulncopilot.org | head -1
```

Certificate errors before the cert is active are expected — wait it out.

## 5. Update the production GitHub OAuth app

In the **existing** production OAuth app (the one whose id/secret are already in
Secret Manager — no secret change is needed):

- **Homepage URL** → `https://vulncopilot.org`
- **Authorization callback URL** → `https://vulncopilot.org/api/auth/callback/github`

GitHub allows a single callback URL per app, so this **replaces** the `run.app`
callback — `run.app` sign-in stops working once steps 5 + 6 are both done (expected).
If you need both hosts to sign in, create a second OAuth app instead.

## 6. Point the app at the apex and redeploy

Edit `.env.yaml`:

```yaml
AUTH_URL: "https://vulncopilot.org"   # was the *.run.app URL
AUTH_TRUST_HOST: "true"               # unchanged — still required behind the proxy
```

Apply it:

```bash
gcloud run services update vulncopilot \
  --region us-central1 \
  --env-vars-file .env.yaml
```

(Or rerun the full step-8 `gcloud run deploy` command.) `--env-vars-file` replaces
only the non-secret env set; your `--set-secrets` bindings are untouched.

> **Sequencing (do not skip):** perform steps 5 and 6 **only after** step 4's cert
> is active and `https://vulncopilot.org` serves the app. The `*.run.app` URL keeps
> working until this flip, so there is no outage window. Doing it earlier points
> `AUTH_URL` at a host that isn't serving yet and breaks sign-in.

## 7. (Optional) `www → apex` redirect

With the apex on DNS-only, Cloudflare Redirect Rules require *proxied* traffic, so
handle `www` separately from the apex:

- Add a `www` record, **Proxied (orange)** — the target can be a placeholder
  (e.g. `AAAA` `100::`), since a Redirect Rule intercepts before the origin.
- Create a Redirect Rule (Rules → Redirect Rules): if hostname equals
  `www.vulncopilot.org`, then `301` to `https://vulncopilot.org${http.request.uri.path}`.

The apex stays DNS-only throughout. Or skip `www` entirely — it simply won't resolve.

## 8. Verify

```bash
# Valid Google-issued cert, app responds
curl -sI https://vulncopilot.org | head -1
curl -svI https://vulncopilot.org 2>&1 | grep -i "issuer:"   # expect Google Trust Services
```

Then walk the surface:

1. **Sign in** on `https://vulncopilot.org` with an allow-listed GitHub account;
   confirm a non-allow-listed account is denied.
2. **Chat** — a query ("List the 10 newest KEV entries by date_added") streams and
   answers from KEV/NVD.
3. **Admin** — `/admin` loads for `ADMIN_USER_IDENTIFIERS`, denied for others.
4. **MCP gate** — without a key the endpoint is 401:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://vulncopilot.org/api/mcp   # expect 401
   ```

5. Confirm the old `*.run.app` sign-in now redirects to the apex (expected after
   the `AUTH_URL`/OAuth flip).

## Rollback

Revert `AUTH_URL` in `.env.yaml` to the `*.run.app` URL and redeploy, and revert
the OAuth app's Homepage/callback URLs. The DNS records and domain mapping can stay
in place — they're harmless without the `AUTH_URL` pointing at them.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Certificate stuck "provisioning" for hours | A record is wrong, or it's **proxied** (must be grey/DNS-only so Google can validate). Recheck records against `domain-mappings describe`; wait up to 24 h. |
| GitHub sign-in redirects to the wrong host or loops | `AUTH_URL` isn't exactly `https://vulncopilot.org`, or the OAuth callback URL doesn't match. Both must be the exact apex. |
| `404` on `https://vulncopilot.org` but `*.run.app` works | Mapping not ready or DNS not propagated yet. Recheck step 2/3 and wait. |
| `UntrustedHost` from NextAuth | `AUTH_TRUST_HOST=true` missing from `.env.yaml` (should already be set from the deploy runbook). |
| `gcloud beta run domain-mappings` unavailable in region | Use an **External HTTPS Load Balancer** (reserve a static IP → serverless NEG → backend service → URL map → target HTTPS proxy → forwarding rule, with a Google-managed cert), then point Cloudflare at the LB IP. More setup and ~$18+/mo fixed cost, but works everywhere and supports Cloud Armor. |

## Relationship to the deploy runbook

After this cutover, `AUTH_URL` in [`deploy-gcp-cloud-run.md`](./deploy-gcp-cloud-run.md)
§6 is `https://vulncopilot.org` rather than the `*.run.app` URL. Everything else in
that runbook is unchanged.
