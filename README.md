# Cloud Storage and File Sharing System

A PSU Software Engineering module project based on the company file-storage and internal-sharing SRS. See the [project specification](PROJECT_SPECIFICATION.md) for product behavior, the [project plan](PROJECT_PLAN.md) for the release finish line, and the [implementation plan](IMPLEMENTATION_PLAN.md) for the next authorized checkpoint.

## Local development

Use Node.js 24, npm, and Docker with Compose. The repository contains a Next.js web app in `apps/web` and a NestJS API in `apps/api`. The integrated local stack combines `compose.yaml`, `compose.integrations.yaml`, and `compose.app.yaml`. Nginx serves the web app and API at the same loopback origin, `http://127.0.0.1:3080` by default. PostgreSQL metadata and private uploaded bytes use separate named volumes.

Run `npm run local:configure` to populate missing class credentials in the ignored local `.env`. Use `npm run typecheck` and `npm run build` for code verification. The CI workflow also builds the local Compose stack and runs the browser checks.

## Class integration fixtures

The local test setup uses Keycloak for OpenID Connect discovery and Mailpit for SMTP capture. Start the optional services from an existing local setup. Run `npm run local:configure` before first starting the class realm. The realm imports its application client and synthetic account passwords from local environment values. The database migration service seeds authorized application identities. If you need local console access, supply `KC_BOOTSTRAP_ADMIN_USERNAME` and `KC_BOOTSTRAP_ADMIN_PASSWORD` in your shell before the first start. Recreating the development container reloads the seed.

~~~sh
docker compose -f compose.yaml -f compose.integrations.yaml up -d identity mailpit
curl --fail http://127.0.0.1:18080/realms/se-final-class/.well-known/openid-configuration
~~~

Mailpit captures local SMTP on `127.0.0.1:11025` and displays messages on `http://127.0.0.1:18025`. The class fixture has no external relay. Keycloak and Mailpit bind to loopback and use development settings. Keep real organizational account and email configuration in the approved environment. [Keycloak container guide](https://www.keycloak.org/server/containers) · [Keycloak realm import](https://www.keycloak.org/server/importExport) · [Mailpit Docker guide](https://mailpit.axllent.org/docs/install/docker/)

| Fixture account | Application case |
| --- | --- |
| `alice` | Active employee and owner of the example folder and uploaded file. |
| `bob` | Active employee and named recipient. Also a member of `project-team`. |
| `priya` | Active member of `project-team` who exercises group-only access. |
| `casey` | Active employee outside the group and without a direct share. |
| `dana` | Valid identity provider account whose application directory entry is inactive. |
| `eve` | Valid identity provider account without an internal application directory entry. |
| `it-admin` | IT Support operator for policy and recovery tests. |
| `security-reviewer` | IT Security reviewer and the synthetic alert recipient. |

Test invalid sign-in with incorrect credentials in the class realm. Test an anonymous request in a separate session. Match internal access by the application directory and issuer/subject. The fixture email addresses are all synthetic.

Use [handover-v1.png](fixtures/files/handover-v1.png) as the first upload and [handover-v2.png](fixtures/files/handover-v2.png) as the replacement revision of the same item. Compare SHA-256 values after upload, download, and restore. Use [unsupported.txt](fixtures/files/unsupported.txt) for type rejection. Later cases will create a nested folder, named and group shares, expired and revoked links, and disposable capacity fixtures sized to the SRS limits.

For deployment, use an authorized Linux VM with SSH/Docker access, persistent disk, and a reachable HTTPS origin. Keep PostgreSQL and private file bytes on persistent volumes accessible only to the necessary services. Check disk headroom for the full quota and a restore copy before running large fixtures. The Docker Desktop check exercises local Linux containers. Class VM, organization identity provider, and approved mail relay access are tracked in the [current handoff](IMPLEMENTATION_PLAN.md#current-handoff).

See [requirements coverage](REQUIREMENTS_COVERAGE.md) for the test IDs and evidence record.
