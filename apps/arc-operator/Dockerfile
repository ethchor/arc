# syntax=docker/dockerfile:1.7
# arc-operator image — built from the repo root context:
#
#   docker build -f apps/arc-operator/Dockerfile -t arc-operator .
#
# Same two-stage shape as apps/arc-server/Dockerfile: build inside the full pnpm workspace,
# then `pnpm deploy --prod --legacy` carves out a self-contained tree onto a slim non-root
# runtime. CRDs ship inside the image at /app/crds for `kubectl apply -f`.
ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /repo

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

RUN pnpm --filter @arc/operator... build
RUN pnpm --filter @arc/operator deploy --prod --legacy /app

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 10001 arc \
 && useradd --system --uid 10001 --gid arc --home-dir /app --shell /usr/sbin/nologin arc

COPY --from=build --chown=arc:arc /app ./
# CRDs ship with the image so operators can install them with `kubectl apply -f /app/crds`
# (or via a Job in the helm chart).
COPY --from=build --chown=arc:arc /repo/apps/arc-operator/crds /app/crds

USER arc

CMD ["node", "dist/main.js"]
