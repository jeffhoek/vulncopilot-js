# syntax=docker/dockerfile:1

# --- deps: install with a frozen lockfile ------------------------------------
FROM node:22-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- builder: compile the Next.js standalone bundle --------------------------
FROM node:22-slim AS builder
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# `next build` imports the page modules during page-data collection, and
# config.ts runs its zod validation at import (fail-fast by design), so the
# required vars must be *present* at build time. These are throwaway
# placeholders passed inline to this RUN only — they are NOT image ENV, never
# reach the runner stage, and are not NEXT_PUBLIC_* so nothing is inlined into
# a bundle. Real values are read from the container's env at request time
# (routes are dynamic — nothing is prerendered with these). Secrets are
# injected only at `podman run` / deploy time.
RUN PG_DATABASE_URL=postgres://build:build@localhost:5432/build \
    ANTHROPIC_API_KEY=sk-build-placeholder \
    OPENAI_API_KEY=sk-build-placeholder \
    pnpm build

# --- runner: minimal image, non-root ----------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000 HOSTNAME=0.0.0.0

# Non-root runtime user (matches the reference image's uid/gid 10001).
RUN groupadd -r -g 10001 appuser && useradd -r -u 10001 -g appuser appuser

# The standalone output already contains a pruned node_modules + server.js.
# .next/static and (if present) public/ are NOT included by standalone — copy them
# alongside. This project has no public/ dir, so it is intentionally omitted.
COPY --from=builder --chown=10001:10001 /app/.next/standalone ./
COPY --from=builder --chown=10001:10001 /app/.next/static ./.next/static

USER 10001
EXPOSE 3000
CMD ["node", "server.js"]
