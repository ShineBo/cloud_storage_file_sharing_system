FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/web/ apps/web/
COPY apps/api/ apps/api/
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
RUN mkdir -p apps/web/node_modules apps/api/node_modules

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN install -d -m 0700 -o node -g node /var/lib/cloud-storage/files
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules/ node_modules/
COPY --from=build --chown=node:node /app/apps/web/node_modules/ apps/web/node_modules/
COPY --from=build --chown=node:node /app/apps/api/node_modules/ apps/api/node_modules/
COPY --from=build --chown=node:node /app/apps/web/package.json apps/web/
COPY --from=build --chown=node:node /app/apps/web/.next/ apps/web/.next/
COPY --from=build --chown=node:node /app/apps/api/package.json apps/api/
COPY --from=build --chown=node:node /app/apps/api/dist/ apps/api/dist/
COPY --chown=node:node apps/api/migrations/ apps/api/migrations/
COPY --chown=node:node scripts/migrate.mjs scripts/
COPY --chown=node:node fixtures/keycloak/ fixtures/keycloak/
USER node
CMD ["node", "apps/api/dist/main.js"]
