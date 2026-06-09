# Multi-stage Dockerfile for the VC Conformance Test Webapp.
#
# Stage 1: install deps + build (compile TypeScript type-check only at this
#          stage; we ship ESM and run via tsx at boot so we don't need a
#          separate compile step).
# Stage 2: copy app + node_modules + tsx; run as non-root.

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# -----

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# Security: run as a non-root user
RUN addgroup -S app && adduser -S app -G app

# Copy production deps and the app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY apps ./apps
COPY references ./references

# MAS-174 follow-up: the persistent run store lives at
# apps/web/data/runs.json. The default COPY above lands the file
# owned by root, so the non-root `app` user below cannot open it for
# write (EACCES on the first /api/runs POST).
RUN chown -R app:app /app/apps && \
    mkdir -p /app/apps/web/data && \
    chown app:app /app/apps/web/data

# Entrypoint wrapper. We deliberately run this as root (we have not yet
# switched to `app` below) so it can chown any tmpfs/volume mounted over
# the data dir at runtime — a tmpfs lands as root and would otherwise
# re-introduce the EACCES bug. The wrapper does its chown and then
# `exec`s into the CMD as the `app` user via `setpriv`/`su-exec`/gosu.
# We use su-exec (built into Alpine via the `su-exec` package) to keep
# the security posture tight: the node process itself never runs as
# root, only the small init step does.
RUN apk add --no-cache su-exec
COPY --chown=root:root ops/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    RUN_HISTORY_DIR=/app/apps/web/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/api/health || exit 1

# Stay as root for the entrypoint (so the chown in the wrapper has
# permission), then drop to `app` via the wrapper's `exec su-exec app:app ...`.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "--import", "tsx", "apps/web/src/server.ts"]
