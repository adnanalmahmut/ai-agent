# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/i18n-core/package.json packages/i18n-core/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter backend...

FROM dependencies AS build
COPY apps/backend apps/backend
COPY packages/i18n-core packages/i18n-core
RUN pnpm --filter @repo/i18n-core build \
    && pnpm --filter backend prisma:generate \
    && pnpm --filter backend build \
    && pnpm --filter backend deploy --legacy --prod /out/backend

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/backend ./
USER node
EXPOSE 3002
CMD ["node", "dist/src/main"]

FROM build AS migration

ENV NODE_ENV=production
USER node
CMD ["pnpm", "--filter", "backend", "prisma", "migrate", "deploy"]
