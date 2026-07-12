# Observability with Langfuse (Mastra AI tracing)

How to configure, reconfigure, and test tracing for this app. Traces let you
inspect each agent run — the model call, the `query`/`retrieve` tool spans, token
usage and cost, and which authenticated user made the request.

## How it's wired

```
chat request → ragAgent.stream(...) → Mastra AI tracing → @mastra/langfuse exporter → Langfuse
                        │
                        └─ tracingOptions.metadata.userId  (github:<id>, attached per request)
```

- **Mastra "AI tracing"** (the modern `observability` config, *not* the deprecated
  OTel `telemetry` field — that stays disabled) is configured in
  [`src/mastra/index.ts`](../src/mastra/index.ts).
- The **native `@mastra/langfuse` exporter** converts spans to Langfuse's format.
  No separate OTel collector is involved.
- Tracing is **enabled only when both `LANGFUSE_PUBLIC_KEY` and
  `LANGFUSE_SECRET_KEY` are set.** With either blank, `observability` is left
  `undefined`, so local dev, `pnpm test`, and CI run trace-free with zero overhead.
- The authenticated GitHub identity is attached to each trace as
  `metadata.userId` in [`app/api/chat/route.ts`](../app/api/chat/route.ts), so runs
  are filterable per user in the Langfuse UI.
- **Delivery is made deterministic by a flush.** Mastra exports spans
  *fire-and-forget*, so the actual Langfuse HTTP send is a floating promise the
  runtime may defer for minutes (dev) or drop entirely (Cloud Run scale-to-zero).
  The chat route calls `after(flushTracing)` (Next's `after()` from `next/server`)
  so the invocation stays alive until the buffered spans are flushed **and the
  send is awaited**. `flushTracing()` lives in `src/mastra/index.ts`. Without it,
  traces arrive late or not at all even though nothing errors.

### Version pin (important)

`@mastra/langfuse` is pinned to **`^0.0.11`**, which resolves to exactly `0.0.11`.
This is deliberate and tied to `@mastra/core@0.20.x`:

- `0.0.11` peer-depends on `@mastra/core >=0.18.1 <0.21.0` and implements the
  `AITracingExporter` interface (`exportEvent`) that core 0.20 exposes.
- Every `@mastra/langfuse` ≥ `0.1.0` was refactored to extend a `BaseExporter`
  base class that **does not exist** in core 0.20 (it landed in core ≥0.22), so
  those versions fail to typecheck/run here despite mislabeled peer ranges.

**Do not bump `@mastra/langfuse` on its own.** If you upgrade it, upgrade
`@mastra/core` (and `@mastra/mcp`) in the same change and re-verify the build. See
[Troubleshooting](#version-mismatch-after-a-dependency-bump).

## Environment variables

| Var | Required for tracing | Default | Notes |
|---|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | yes | — | `pk-lf-…` from the Langfuse project |
| `LANGFUSE_SECRET_KEY` | yes | — | `sk-lf-…` — **secret**, store in a secrets manager |
| `LANGFUSE_BASE_URL` | no | `https://us.cloud.langfuse.com` | **Must match your keys' region.** US (default) / EU `https://eu.cloud.langfuse.com` / self-hosted URL. The legacy `https://cloud.langfuse.com` 401s for region-scoped accounts |
| `LANGFUSE_REALTIME` | no | `true` | Flush each span immediately. See [realtime vs batch](#realtime-vs-batch) |
| `LANGFUSE_DEBUG` | no | `false` | Raise exporter logging to `debug` (per-trace-creation logs). Diagnostic only — noisy |

All four are declared and validated in [`src/lib/config.ts`](../src/lib/config.ts)
and stubbed in [`.env.example`](../.env.example).

## Local setup & test

1. **Create a Langfuse project.** Sign up at <https://cloud.langfuse.com> (or run
   Langfuse self-hosted). In **Project Settings → API Keys**, create a key pair.

2. **Add the keys to `.env`** (never commit them):

   ```dotenv
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   # LANGFUSE_BASE_URL defaults to the US host. Uncomment for an EU project:
   # LANGFUSE_BASE_URL=https://eu.cloud.langfuse.com
   ```

   > The host **must match the region your keys were issued in** (US vs EU), or
   > Langfuse returns `401 ... confirm the correct host`. Verify with the one-liner
   > in [Troubleshooting → No traces / 401](#no-traces-appear--401-unauthorized).

3. **Run the app and make a query.** Start `pnpm dev` fresh — `.env` is read only
   at server startup, so after changing any `LANGFUSE_*` var you must **fully stop
   and restart** the dev server (Ctrl-C then `pnpm dev`); a hot-reload/file-save
   will keep using the old values.

   ```bash
   pnpm dev
   ```

   Sign in, then ask something that exercises both tools, e.g. *"Tell me about
   Log4Shell"* (semantic → `retrieve`) and *"List the 10 newest KEV entries"*
   (SQL → `query`).

4. **Confirm the trace.** In the Langfuse UI → **Tracing**, a trace appears within
   a second or two (realtime mode). Open it and verify:
   - a root **agent** span, with a child **model** generation showing input/output
     tokens,
   - **tool** spans for `query` / `retrieve`,
   - **`metadata.userId`** = your `github:<id>` on the trace.

   No trace? See [Troubleshooting](#troubleshooting).

5. **Confirm the off switch.** Blank either key and restart — the app runs
   normally and nothing is sent to Langfuse.

## realtime vs batch

`LANGFUSE_REALTIME` defaults to **`true`** (attempt a flush after each span), which
narrows the window in which spans sit buffered. It is **not** what guarantees
delivery, though — that is the `after(flushTracing)` call in the chat route (see
[How it's wired](#how-its-wired)), which awaits the send after every response
regardless of this flag. Because of that guarantee, `LANGFUSE_REALTIME=false`
(batch mode, fewer HTTP calls) is safe everywhere, including Cloud Run scale-to-zero
— the `after()` flush keeps the invocation alive until the batch is sent. Leave it
`true` if you also want spans to appear mid-run for long streams.

## Reconfiguring

- **Rotate keys:** issue a new pair in Langfuse, update `LANGFUSE_SECRET_KEY` /
  `LANGFUSE_PUBLIC_KEY`, restart (locally) or roll a new revision (Cloud Run — see
  below). Revoke the old pair in Langfuse.
- **Switch region / self-host:** point `LANGFUSE_BASE_URL` at the matching host and
  use keys issued by *that* instance (keys are per-instance).
- **Turn tracing off:** unset either key.
- **Toggle flush behavior:** set `LANGFUSE_REALTIME`.

## Deploying to Cloud Run

Tracing config is orthogonal to the deploy mechanics, but touches
[`deploy-gcp-cloud-run.md`](./deploy-gcp-cloud-run.md) in three spots. Apply these
when the observability and deploy branches converge (the deploy runbook currently
lives on a separate branch — see the note at the end of this file):

1. Create `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` as **Secret Manager**
   secrets (add both to the create loop and the `--set-secrets` list). The public
   key isn't strictly sensitive, but keeping the pair together is simpler.
2. Add `LANGFUSE_BASE_URL` and `LANGFUSE_REALTIME` to **`.env.yaml`** (non-secret).
3. Keep `LANGFUSE_REALTIME=true` (the default) on Cloud Run scale-to-zero.

Concretely, the deploy runbook's `--set-secrets` line gains
`,LANGFUSE_PUBLIC_KEY=LANGFUSE_PUBLIC_KEY:latest,LANGFUSE_SECRET_KEY=LANGFUSE_SECRET_KEY:latest`,
its secret-create loop gains those two names, and `.env.yaml` gains
`LANGFUSE_BASE_URL` / `LANGFUSE_REALTIME`.

After changing a Langfuse secret, force a new revision so it's picked up:

```bash
echo -n "pk-lf-new" | gcloud secrets versions add LANGFUSE_PUBLIC_KEY --data-file=-
gcloud run services update vulncopilot --region us-central1
```

**Verify in production:** make a query against the deployed URL, then confirm the
trace shows up in Langfuse with the expected `environment` tag (set from
`NODE_ENV`, i.e. `production`) and your `userId`.

## Troubleshooting

### No traces appear / `401 Unauthorized`
The Langfuse SDK error `401 ... Invalid credentials. Confirm that you've configured
the correct host` means the keys are valid but sent to the **wrong regional host**
(most common), or the keys are wrong. Note Langfuse can emit this 401 while *some*
events still land — that's usually a **stale dev process** (see below), not partial
auth.

- **Confirm which host your keys belong to.** This tests the actual `.env` values
  against each region without printing the secret:

  ```bash
  node --env-file=.env -e '
    const a="Basic "+Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
    for (const h of ["https://us.cloud.langfuse.com","https://eu.cloud.langfuse.com","https://cloud.langfuse.com"])
      fetch(h+"/api/public/projects",{headers:{Authorization:a}}).then(r=>console.log(r.status===200?"✅ "+h:"❌ "+r.status+" "+h));
  '
  ```

  Set `LANGFUSE_BASE_URL` to the host that prints `✅`. (The legacy
  `https://cloud.langfuse.com` `❌ 401`s for region-scoped accounts — expected.)

- **Fully restart after any `LANGFUSE_*` change.** `.env` is read only at server
  start, and the Mastra instance is cached on `globalThis` across hot-reloads, so a
  file-save won't repoint the exporter. Ctrl-C `pnpm dev` and start it again. On
  Cloud Run, roll a new revision.
- **Both keys set?** Tracing is off unless *both* `LANGFUSE_PUBLIC_KEY` and
  `LANGFUSE_SECRET_KEY` are present. Check the running env, not just `.env`.

### Traces appear in a burst, then stop (no errors)
Auth is fine (some traces landed) but new queries stop showing up. In local
`pnpm dev` this is almost always a **hot-reload lifecycle** artifact, not a code
error — the exporter opens a Langfuse client with a flush timer and process
listeners, and repeated hot-reloads can leave a stale instance in play.

**Tell-tale: a backlog flushes all at once when you Ctrl-C the dev server.** That
means the queued events were only drained by the shutdown handler — i.e. the live
process is **not** doing per-event realtime flushing (almost always a stale
instance from before `LANGFUSE_REALTIME`/your config loaded). On boot the app logs
one line, `[observability] Langfuse tracing ENABLED host=… realtime=… debug=…`; if
you don't see it (or it shows the wrong values) after starting, you're on a stale
process.

1. **Fully restart `pnpm dev`** (Ctrl-C, not a file-save reload; kill any stray
   `next dev` first) and confirm the `[observability] … ENABLED … realtime=true`
   line prints. A clean process holds one stable exporter (constructed once and
   cached on `globalThis`) and flushes each span immediately — new queries should
   appear in Langfuse within a second or two, with no backlog.
2. If it still stalls, set **`LANGFUSE_DEBUG=true`**, restart, and watch the
   console while making several queries:
   - Exporter warnings like `Langfuse exporter: No trace data found for span` or
     `No Langfuse span found for span update/end` mean spans are arriving without
     their parent trace — report these.
   - `[AI Tracing] Export error [exporter=langfuse]` means the client itself
     rejected an event (check the attached error/host).
   - **No** export logs at all for the later queries means Mastra stopped emitting
     spans for those runs (a tracer lifecycle issue) rather than the exporter
     failing.
3. Confirm you didn't set `LANGFUSE_REALTIME=false` locally — in batch mode a
   short-lived process can exit before the interval flush.

### Traces appear locally but not on Cloud Run
Almost always dropped batched flushes on scale-to-zero. Confirm
`LANGFUSE_REALTIME` is `true` (default) — or that you didn't set it to `false`.

### `metadata.userId` missing on traces
The user id is attached in the chat route's `agent.stream(..., { tracingOptions:
{ metadata: { userId } } })`. Only the chat path is user-attributed; other entry
points (e.g. the MCP route) won't carry a `userId`.

### Version mismatch after a dependency bump
Symptoms: `tsc` error *"Property 'exportEvent' is missing … required in type
'AITracingExporter'"*, or a runtime "BaseExporter not found". Cause: a
`@mastra/langfuse` version newer than `@mastra/core` supports. Fix: pin
`@mastra/langfuse` back to `0.0.11` for core `0.20.x`, **or** upgrade
`@mastra/core`/`@mastra/mcp` to a matching line and re-verify. See
[Version pin](#version-pin-important).

## Verifying the wiring (what "done" looks like)

```bash
pnpm test        # 45 passing — unaffected (tracing is import-guarded)
npx tsc --noEmit # clean
pnpm build       # builds with tracing disabled (no keys at build time)
```

Then the local trace check in [Local setup & test](#local-setup--test).

---

> **Branch note.** This observability work is on its own branch, kept separate
> from the GCP deploy runbook (which lives on the "Add GCP Cloudrun deploy plan"
> branch, not yet on `main`). The [Deploying to Cloud Run](#deploying-to-cloud-run)
> edits above are written to be applied to `deploy-gcp-cloud-run.md` once both land
> on `main`. Until then, the link to that file resolves only on branches that
> include it.
