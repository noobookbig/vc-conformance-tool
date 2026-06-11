# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for the v2 conformance test tool (CLI + HTTP server + web SPA).
#
# Stages:
#   1. ui-build  - build the Vite SPA into apps/conformance-v2/web/dist/
#   2. deps      - install the engine + server deps (root prod + dev, we
#                  need `tsx` at runtime to run TypeScript without a
#                  separate compile step — mirrors the v0.1.0 image)
#   3. runtime   - copy the engine + server + the built SPA; non-root user;
#                  defaults to the server (UI mode) on :8080, CLI is a subcommand.
#
# Build context is the repo root. The full context is required because the
# SPA build resolves imports from sibling source files. If you build from
# a narrower context the UI stage will fail with a missing-tsconfig error.
#
# Versioning:
#   - IMAGE_VERSION build arg, default 2.1.0. Surfaced in the image as
#     CONFORMANCE_V2_VERSION so /api/health can report it.

ARG NODE_VERSION=22-alpine
ARG IMAGE_VERSION=2.1.2

# ----------------------------------------------------------------------------
# Stage 1: build the Vite SPA. We keep only the built dist/ directory;
# node_modules and TS source are dropped here.
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS ui-build
WORKDIR /app

# bash is required by scripts/refresh-case-roles.sh (uses `set -euo pipefail`
# and `[[ ]]`). node:alpine ships with busybox ash only; the runtime stage
# gets bash transitively via su-exec on glibc images, but we install it
# explicitly here so the ui-build layer is self-sufficient.
RUN apk add --no-cache bash

# Copy the SPA's own manifests + lockfile first so the install layer caches
# when only source changes.
COPY apps/conformance-v2/web/package.json apps/conformance-v2/web/package-lock.json* ./apps/conformance-v2/web/
# The SPA build needs the engine's source to resolve TS imports across
# the workspace sibling. We copy the minimum surface that Vite reaches.
COPY apps/conformance-v2 ./apps/conformance-v2
# The catalog → case-roles.json generator. We copy the script + the
# catalog it reads so the ui-build stage can regenerate the JSON in
# sync with the catalog before tsc runs (roles.ts imports the JSON).
COPY scripts/refresh-case-roles.sh ./scripts/refresh-case-roles.sh
COPY references/testcases ./references/testcases

RUN chmod +x ./scripts/refresh-case-roles.sh && \
    bash ./scripts/refresh-case-roles.sh

RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --prefix apps/conformance-v2/web

RUN npm run build --prefix apps/conformance-v2/web

# ----------------------------------------------------------------------------
# Stage 2: install the engine + server deps. We keep dev deps because
# `tsx` lives there and the runtime needs it to execute TypeScript
# without a separate compile step.
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ----------------------------------------------------------------------------
# Stage 3: runtime. Non-root, defaults to server (UI mode) on :8080, CLI is
# a subcommand.
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ARG IMAGE_VERSION=2.1.2
WORKDIR /app

# Security: non-root user for the node process. The entrypoint wrapper
# (su-exec) handles the small privilege drop, mirroring ops/docker/.
RUN addgroup -S app && adduser -S app -G app && \
    apk add --no-cache su-exec

# Copy the engine + server + the catalog of test cases.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
# Only ship the v2 app — v0.1.0 (apps/web) is not in the v2 image.
COPY apps/conformance-v2 ./apps/conformance-v2
COPY references ./references

# Copy the built SPA dist only (no source, no node_modules). The server
# resolves this path as `apps/conformance-v2/web/dist` from the repo root;
# see `resolveWebDist()` in apps/conformance-v2/src/server.ts.
COPY --from=ui-build --chown=app:app /app/apps/conformance-v2/web/dist ./apps/conformance-v2/web/dist

# Reports written by the CLI mode land here by default. The CLI smoke
# mounts a tmpfs at this path so the artefact is visible on the host.
RUN mkdir -p /out && chown -R app:app /out

# Entrypoint wrapper. We deliberately run as root so the wrapper can chown
# the (possibly tmpfs-mounted) /out dir before dropping to `app` via
# su-exec. Without that the first `docker run -v` would EACCES.
COPY --chown=root:root ops/docker-v2/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# CLI runner wrapper for the `runner` compose service. Provides
# --config / --catalog / --out defaults and folds in the ROLE /
# INCLUDE_COVERAGE env vars; invoked as a `command:` override by
# `docker compose run --rm runner ...`. See docker-compose.yml.
COPY --chown=root:root ops/docker-v2/v2-runner.sh /usr/local/bin/v2-runner.sh
RUN chmod +x /usr/local/bin/v2-runner.sh

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CONFORMANCE_V2_VERSION=${IMAGE_VERSION} \
    OUT_DIR=/out

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/api/health || exit 1

# Default to server (UI mode). CLI is invoked as:
#   docker run --rm vc-conformance-v2:2.0.0 run --config /cfg.yaml --out /out
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "--import", "tsx", "apps/conformance-v2/src/server.ts", \
     "--catalog", "references/testcases", \
     "--web-dist", "/app/apps/conformance-v2/web/dist", \
     "--port", "8080", "--host", "0.0.0.0"]
