FROM node:20-alpine AS base
RUN apk add --no-cache python3 make g++ libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
RUN rm -rf node_modules/better-sqlite3/prebuilds \
    && npm rebuild better-sqlite3 --build-from-source 2>&1 | tail -6 \
    && echo "=== resulting .node ===" && find node_modules/better-sqlite3 -name '*.node' -exec ls -la {} \;
