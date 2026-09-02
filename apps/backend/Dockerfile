# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base

RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# `pnpm-workspace.yaml` pins `patchedDependencies`, and pnpm reads every
# patch while resolving config — before it applies `--filter`. So this is
# required by every image, including ones that do not depend on the patched
# package, or `pnpm install` fails with ENOENT. See `patches/README.md`.
COPY patches patches
COPY apps/backend/package.json apps/backend/package.json
# The root prepare lifecycle builds workspace packages during install, so their
# build inputs must already exist in the dependency layer.
COPY packages/i18n-core packages/i18n-core
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter backend...

FROM dependencies AS build
COPY apps/backend apps/backend
RUN pnpm --filter @repo/i18n-core build \
    && DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm --filter backend prisma:generate \
    && pnpm --filter backend build \
    && pnpm --filter backend deploy --legacy --prod /out/backend

FROM base AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/backend ./
USER node
EXPOSE 3002
CMD ["node", "dist/src/api/main"]

FROM build AS migration

ENV NODE_ENV=production
WORKDIR /workspace/apps/backend
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
