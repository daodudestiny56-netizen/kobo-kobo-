# One image for the API and the web app. The web app is built in live mode and calls /api/v1 on the same host.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web ./
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_MODE=live
RUN npm run build

FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY server/src ./server/src
COPY --from=web /web/.next/standalone ./web
COPY --from=web /web/.next/static ./web/.next/static
COPY --from=web /web/public ./web/public
COPY docker/entry.mjs ./entry.mjs
USER node
EXPOSE 8080
CMD ["node", "entry.mjs"]
