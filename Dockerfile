# One Dockerfile, one target per process:
#   docker build --target context-api -t proba-context-api .
# Targets: context-api

# Stage 1: build every workspace
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
# The protocol package is installed from a git tag (see package.json), which needs git.
RUN apk add --no-cache git
WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY apps/context-api/package.json apps/context-api/
RUN npm ci
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build

# Stage 2: production dependencies only
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS prod-deps
RUN apk add --no-cache git
WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY apps/context-api/package.json apps/context-api/
RUN npm ci --omit=dev && npm cache clean --force

# Stage 3: shared runtime base (no git, non-root user)
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime
RUN addgroup -g 1001 -S proba && adduser -u 1001 -S proba -G proba
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=builder /app/packages/core/package.json /app/packages/core/
COPY --from=builder /app/packages/core/dist /app/packages/core/dist
COPY --from=builder /app/packages/adapters/package.json /app/packages/adapters/
COPY --from=builder /app/packages/adapters/dist /app/packages/adapters/dist
COPY --chown=proba:proba config ./config
USER proba

# --- app targets ---
FROM runtime AS context-api
COPY --from=builder --chown=proba:proba /app/apps/context-api/package.json /app/apps/context-api/
COPY --from=builder --chown=proba:proba /app/apps/context-api/dist /app/apps/context-api/dist
ENV PORT=3500
EXPOSE 3500
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "apps/context-api/dist/index.js"]
