# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

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

COPY apps/platform apps/platform

ARG VITE_APP_NAME
RUN test -n "$VITE_APP_NAME"
RUN VITE_APP_NAME="$VITE_APP_NAME" pnpm --filter @repo/i18n-core build && \
    VITE_APP_NAME="$VITE_APP_NAME" pnpm --filter platform build && \
    ! grep -R "%VITE_" /workspace/apps/platform/dist

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY apps/platform/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/platform/dist /usr/share/nginx/html/platform
USER 101
EXPOSE 8080
