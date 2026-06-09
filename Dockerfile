# syntax=docker/dockerfile:1.7
# BetterAI server — multi-stage build.
# Phase 1.0 (Wave 3): build with node:22-bookworm, runtime on node:22-bookworm-slim.

# ---------- Stage 1: build ----------
FROM node:22-bookworm AS build

WORKDIR /build

# Copy manifests first so npm ci can cache when source changes.
COPY package.json package-lock.json* ./

# npm ci needs a lockfile. If absent (Phase 1.0 scaffold), fall back to npm install
# so the image still builds; CI will produce a lockfile in a later wave.
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

# Copy source and compile TypeScript.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production-only deps for the runtime stage.
RUN npm prune --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim AS runtime

# Default env. docker-compose overrides; these are sane fallbacks for `docker run`.
ENV NODE_ENV=production \
    BETTERAI_CORPUS_ROOT=/data \
    BETTERAI_AUDIT_PATH=/data/audit/audit.jsonl \
    BETTERAI_PROJECTS_ROOT=/projects \
    BETTERAI_MCP_PORT=7777 \
    BETTERAI_TOKEN_PATH=/data/token \
    BETTERAI_LOG_LEVEL=info

WORKDIR /app

# Copy compiled output and production node_modules from the build stage.
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist

# Non-root user. The node:22-bookworm-slim base ships a `node` user at UID 1000,
# but we set it explicitly so the image matches host UID 1000:1000 by default.
# docker-compose will re-set `user:` from host UID/GID at install time.
USER 1000:1000

EXPOSE 7777

# Health endpoint is gated separately (bearer-bypass per the security rule).
# Compose-level healthcheck calls /health; docker run users can `docker exec` curl.

CMD ["node", "dist/index.js"]
