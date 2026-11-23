FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY apps/web/ apps/web/
COPY apps/api/ apps/api/
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
RUN mkdir -p apps/web/node_modules apps/api/node_modules

FROM dependencies AS recovery-dependencies
# Reuse the locked PostgreSQL client and its runtime dependencies.
RUN node --input-type=module <<'JS'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'

const copied = new Set()
function copyPackage(name, requireFrom) {
  let directory = dirname(requireFrom.resolve(name))
  while (directory.startsWith('/app/node_modules/') && !existsSync(join(directory, 'package.json'))) {
    directory = dirname(directory)
  }
  if (!directory.startsWith('/app/node_modules/')) throw new Error(`Package not found: ${name}`)
  if (copied.has(directory)) return
  copied.add(directory)
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const requireDependency = createRequire(manifestPath)
  cpSync(directory, join('/recovery-dependencies', relative('/app/node_modules', directory)), { recursive: true })
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    copyPackage(dependency, requireDependency)
  }
}
copyPackage('pg', createRequire('/app/package.json'))
JS

FROM postgres:17-bookworm AS recovery
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=recovery-dependencies /recovery-dependencies/ node_modules/
COPY scripts/recovery.mjs scripts/recovery-archive.mjs scripts/
RUN node -e "require('pg')" && pg_dump --version && pg_restore --version \
    && install -d -m 0700 -o 1000 -g 1000 /var/lib/cloud-storage/files
USER 1000:1000
ENTRYPOINT ["node", "/app/scripts/recovery.mjs"]
CMD ["status"]

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
