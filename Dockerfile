# syntax = docker/dockerfile:1

# Bench: one Node process serving the pages, the API, /readme/ and the
# WebSocket, with SQLite (node:sqlite, no native module) on the /data volume.
# fly.toml fixes the rest: 256 MB, one machine, PORT set, /data mounted.

FROM docker.io/library/node:24.21.0-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY client ./client
COPY shared ./shared
RUN pnpm build

FROM docker.io/library/node:24.21.0-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && npm uninstall -g pnpm
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY --from=build /app/public/build ./public/build
COPY README.md ./
COPY docs ./docs
# --disable-warning keeps the log readable: node:sqlite still prints an
# experimental notice on every start.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
