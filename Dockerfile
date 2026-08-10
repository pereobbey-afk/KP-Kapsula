# Один образ на два процесса: веб-сервер и воркер.
# Различаются только командой запуска, поэтому код и зависимости общие.

FROM node:22-bookworm-slim AS build

WORKDIR /app

# Сборка better-sqlite3 требует инструментов компиляции.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
RUN npm run build

# Оставляем только зависимости времени выполнения.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-web ./dist-web
COPY package.json ./

# Данные и загрузки лежат на постоянном томе, а не в слое образа.
RUN mkdir -p /data /storage && chown -R node:node /data /storage
ENV DATABASE_PATH=/data/ii-smetchik.sqlite
ENV STORAGE_DIR=/storage
VOLUME ["/data", "/storage"]

USER node
EXPOSE 3000

# tini корректно доставляет SIGTERM: воркер должен успеть завершить задачу.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/main.js"]
