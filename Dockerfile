# ---- Dependencies stage ----
# better-sqlite3 is only used by the SQLite driver (local dev/tests). In Docker
# we default to the PostgreSQL (pure-JS `pg`) driver, which needs no toolchain.
# Install build tools anyway as insurance in case a native module must compile.
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---- Runtime stage (slim) ----
FROM node:22-alpine AS runtime
WORKDIR /app
# ffmpeg is NOT installed by default: uploads use files the user supplies.
# Add server-side pre-processing later with: apk add --no-cache ffmpeg
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data /app/storage && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
