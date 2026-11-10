# One container, one public port (8080). Build for the sandbox cluster:
#   docker build -f server/Dockerfile --platform linux/amd64 -t <registry>/<image>:v1 .
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/kobo.sqlite
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY server/tsconfig.json ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
