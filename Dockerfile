# Inkling on Railway (or any Docker host): one Next.js server with SQLite on a persistent volume.
# See docs/railway.md. Build stage: the full Debian Node image, because npm runs node-gyp for
# better-sqlite3 (a native addon; it finds the bundled linux prebuild, but gyp itself needs python3
# and make, and a compiler is there should it ever have to build from source).
FROM node:22-bookworm AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# NEXT_PUBLIC_* values are inlined into the build: Railway passes service variables to declared
# ARGs, so set NEXT_PUBLIC_SITE_URL before deploying (and redeploy after changing it).
ARG NEXT_PUBLIC_SITE_URL
ARG RAILWAY_PUBLIC_DOMAIN
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} RAILWAY_PUBLIC_DOMAIN=${RAILWAY_PUBLIC_DOMAIN}
# The build cache is only useful to the next build on this machine: keep it out of the image.
RUN npm run build && rm -r -f .next/cache

# Runtime: same Debian release (glibc) as the build, without the toolchain. node_modules keeps the
# dev dependencies on purpose: `seed:demo` (run by scripts/start-prod.mjs) uses tsx.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 INKLING_DATA_DIR=/data
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "scripts/start-prod.mjs"]
