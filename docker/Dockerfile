# build from the repo root: docker build -f docker/Dockerfile .
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --ignore-scripts \
  && npm rebuild better-sqlite3 @serialport/bindings-cpp esbuild
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build --workspace @meshkeep/shared \
  && npm run build --workspace @meshkeep/server \
  && npm run build --workspace @meshkeep/web

FROM node:26-bookworm-slim
# Baseline OCI metadata for local builds; the release workflow augments these
# (revision, version, created) via docker/metadata-action labels.
LABEL org.opencontainers.image.source="https://github.com/TMASoft/meshkeep" \
      org.opencontainers.image.title="MeshKeep" \
      org.opencontainers.image.description="Self-hosted MeshCore companion web client — chat, contacts, channels, and map for your LoRa mesh." \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
# udevadm backs serialport's device enumeration (Radio → Connection detection)
RUN apt-get update && apt-get install -y --no-install-recommends udev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN npm ci --ignore-scripts --omit=dev --workspace @meshkeep/server --include-workspace-root=false \
  && npm rebuild better-sqlite3 @serialport/bindings-cpp \
  && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/package.json packages/server/package.json
COPY --from=build /app/packages/web/dist packages/web/dist

ENV MESHKEEP_PORT=8080 \
    MESHKEEP_DATA_DIR=/data
VOLUME /data
EXPOSE 8080

# dialout group for /dev/tty* access when devices are passed through
RUN usermod -aG dialout node && mkdir -p /data && chown node:node /data
USER node

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.MESHKEEP_PORT+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
