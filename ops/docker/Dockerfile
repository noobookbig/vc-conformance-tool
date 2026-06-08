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

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    NPM_CONFIG_UPDATE_NOTIFIER=false

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/api/health || exit 1

USER app

# Use tsx at runtime so we don't need a separate build step.
# node --import tsx loads TS source directly via Node's loader.
CMD ["node", "--import", "tsx", "apps/web/src/server.ts"]
