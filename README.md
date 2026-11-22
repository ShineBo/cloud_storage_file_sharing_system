# Cloud Storage & File Sharing

A private file workspace for teams. Sign in with an organization account to upload, list, and download files in your own workspace.

The app currently supports OpenID Connect sign-in and PNG uploads up to 10 MiB. File metadata is stored in PostgreSQL and file contents are kept on a private volume. Folders, sharing links, and version history are planned.

## Run locally

Use Node.js 24 and Docker with Compose.

```sh
npm run local:configure
docker compose -f compose.yaml -f compose.integrations.yaml -f compose.app.yaml build api
docker compose -f compose.yaml -f compose.integrations.yaml -f compose.app.yaml up -d --no-build --wait --wait-timeout 120
```

Open [the local workspace](http://127.0.0.1:3080) and sign in as `alice` with the `CLASS_FIXTURE_PASSWORD` generated in your local `.env`.

The stack uses Next.js, NestJS with Fastify, PostgreSQL, Keycloak, and Nginx.
