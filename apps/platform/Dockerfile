# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS dependencies

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
COPY apps/platform/package.json apps/platform/package.json
# The root prepare lifecycle builds workspace packages during install, so their
# build inputs must already exist in the dependency layer.
COPY packages/i18n-core packages/i18n-core
COPY packages/ui packages/ui
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter platform...

FROM dependencies AS build
COPY apps/platform apps/platform
ARG NEXT_PUBLIC_APP_NAME=Feedogo
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
RUN test -n "$NEXT_PUBLIC_APP_NAME"
RUN pnpm --filter @repo/i18n-core build && pnpm --filter platform build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8080
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=build --chown=nextjs:nodejs /workspace/apps/platform/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /workspace/apps/platform/.next/static ./apps/platform/.next/static
COPY --from=build --chown=nextjs:nodejs /workspace/apps/platform/public ./apps/platform/public
USER nextjs
EXPOSE 8080
CMD ["node", "apps/platform/server.js"]
