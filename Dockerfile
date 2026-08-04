# syntax=docker/dockerfile:1
# Jobber MCP server, HTTP transport, for Coolify on the Colima (linux/arm64) host.
#
#  - Stage 1 compiles TypeScript -> dist/
#  - Stage 2 runs dist/http.js with production dependencies only
#
# Tokens live on a mounted volume (JOBBER_TOKEN_STORE), not in the image: Jobber
# rotates the refresh token on every refresh, so the current one must outlive
# any single container.

############################
# Stage 1 — build
############################
FROM node:22-bookworm-slim AS build
WORKDIR /app

# `prepare` runs the build on install, which would fail before sources are
# copied — skip lifecycle scripts and build explicitly below.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

############################
# Stage 2 — runtime
############################
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# Token store lives here; mount a volume over it so rotation survives redeploys.
RUN mkdir -p /data && chown node:node /data
ENV JOBBER_TOKEN_STORE=/data/tokens.json
VOLUME ["/data"]

# Drop root — nothing here needs it.
USER node

ENV PORT=3000
EXPOSE 3000

# Node 22 has fetch built in, so the healthcheck needs no extra packages.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http.js"]
