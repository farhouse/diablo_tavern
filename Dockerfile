FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG NUXT_PUBLIC_BUILD_SHA=development
ENV NUXT_PUBLIC_BUILD_SHA=$NUXT_PUBLIC_BUILD_SHA
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.output /app/.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
