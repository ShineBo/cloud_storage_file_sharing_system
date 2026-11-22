# Cloud Storage & File Sharing

A private file workspace for teams. Sign in with an organization account to upload, organize, and download files in your own workspace.

Organize files in a private folder hierarchy and share individual files or folders with employees and approved groups. Recipients sign in to preview shared content. Owners can allow downloads separately and revoke links at any time. Links expire after 30 days by default.

The app accepts PDF, DOCX, XLSX, PPTX, JPEG, and PNG files, with a default limit of 2 GB per file and 20 GB per employee. PostgreSQL stores metadata and SHA-256 hashes. File contents are kept on a private volume.

## Run locally

Use Node.js 24 and Docker with Compose.

```sh
npm run local:configure
docker compose -f compose.yaml -f compose.integrations.yaml -f compose.app.yaml build api
docker compose -f compose.yaml -f compose.integrations.yaml -f compose.app.yaml up -d --no-build --wait --wait-timeout 120
```

Open [the local workspace](http://127.0.0.1:3080) and sign in as `alice` with the `CLASS_FIXTURE_PASSWORD` generated in your local `.env`.

The stack uses Next.js, NestJS with Fastify, PostgreSQL, Keycloak, and Nginx.
