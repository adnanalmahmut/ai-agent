# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/platform/package.json apps/platform/package.json
# The root prepare lifecycle builds workspace packages during install, so their
# build inputs must already exist in the dependency layer.
COPY packages/i18n-core packages/i18n-core
COPY packages/ui packages/ui
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter platform...

COPY apps/platform apps/platform
RUN pnpm --filter @repo/i18n-core build && pnpm --filter platform build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY apps/platform/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/platform/dist /usr/share/nginx/html/platform
USER 101
EXPOSE 8080
