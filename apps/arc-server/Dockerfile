# syntax=docker/dockerfile:1.7
# Multi-stage build for arc-server (the image the helm chart + terraform reference as
# ghcr.io/ethchor/arc-server). Built from the repo root context:
#
#   docker build -f apps/arc-server/Dockerfile -t arc-server .
#
# Stage 1 installs the whole pnpm workspace + builds arc-server and its @arc/* deps, then
# `pnpm deploy` carves out a self-contained, production-only tree. Stage 2 copies just that
# tree onto a slim, non-root runtime.
ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /repo

# The whole workspace is needed: pnpm --frozen-lockfile validates every package.json in the
# lockfile, and the build resolves arc-server's @arc/* workspace deps. .dockerignore keeps
# node_modules / dist / build caches out of the context.
COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Build arc-server + every workspace package it depends on (the `...` selector).
RUN pnpm --filter @arc/server... build

# Carve out a self-contained, production-only deployment of just arc-server. pnpm v10 needs
# --legacy to deploy a non-injected workspace; --prod drops devDependencies.
RUN pnpm --filter @arc/server deploy --prod --legacy /app

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app

# Run as a non-root, unprivileged user (uid matches the chart's runAsUser default).
RUN groupadd --system --gid 10001 arc \
 && useradd --system --uid 10001 --gid arc --home-dir /app --shell /usr/sbin/nologin arc

COPY --from=build --chown=arc:arc /app ./

USER arc
EXPOSE 3001

# Liveness against the /metrics endpoint the observability module always serves.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/metrics').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb defaults; real config (DATABASE_URL, JWT_SECRET, BAO_ADDR, OTEL_*) comes from the
# environment / the chart's Secret.
CMD ["node", "dist/main.js"]
