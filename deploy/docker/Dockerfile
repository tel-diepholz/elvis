# syntax=docker/dockerfile:1
# ELVIS – Server und Web-Oberfläche in einem Image.
FROM node:22-bookworm-slim AS build
WORKDIR /src
# Build-Werkzeuge für better-sqlite3 (falls kein passendes Prebuild verfügbar ist)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages packages
COPY apps apps
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    ELVIS_DATA_DIR=/data \
    ELVIS_CONFIG=/config/elvis.json \
    ELVIS_WEB_DIST=/app/apps/web/dist \
    ELVIS_ADDONS_DIR=/app/addons \
    ELVIS_ADDON_REPOSITORIES=https://raw.githubusercontent.com/tel-diepholz/elvis-addons/main
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/apps/server/package.json apps/server/
COPY --from=build /src/apps/server/dist apps/server/dist
COPY --from=build /src/apps/web/dist apps/web/dist
COPY addons addons
RUN mkdir -p /data /config && chown node:node /data /config
USER node
VOLUME ["/data", "/config"]
# 2525: SMTP-Empfänger für „Scan an E-Mail“ (Scan-Eingang)
EXPOSE 8080 2525
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
