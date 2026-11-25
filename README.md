# Cloud Storage & File Sharing

A private file workspace for teams. Sign in with an organization account to upload, organize, and download files in your own workspace.

Organize files in a private folder hierarchy and share individual files or folders with employees and approved groups. Recipients get an email link and sign in to preview shared content. Owners can check delivery status, retry failed email, and copy the same link. Owners can allow downloads separately and revoke links at any time. Links expire after 30 days by default. Owners and editors can publish a revision while keeping the same file and link. The current version shows its author and publication time, and security reviewers can access activity records and receive alerts for configured access events.

The app accepts PDF, DOCX, XLSX, PPTX, JPEG, and PNG files, with a default limit of 2 GB per file and 20 GB per employee. PostgreSQL stores metadata and SHA-256 hashes. File contents are kept on a private volume.

Workspace owners can move items to Trash and restore them within the recovery window. IT policy administrators can manage approved uploads, storage quotas, link lifetimes, recovery windows, and account access.

## Run locally

Use Node.js 24 and Docker with Compose.

```sh
npm run local:configure
docker compose -f compose.yaml -f compose.integrations.yaml -f compose.app.yaml build api
docker compose -f compose.yaml -f compose.integrations.yaml -f compose.app.yaml up -d --no-build --wait --wait-timeout 120
```

Open [the local workspace](http://127.0.0.1:3080) and sign in as `alice` with the `CLASS_FIXTURE_PASSWORD` generated in your local `.env`.

Open [Mailpit](http://127.0.0.1:18025) to inspect share emails and security alerts in the local stack.

To try the sharing workflow, create a folder, open it, and upload `tests/fixtures/sample.pdf`. Select **Share** next to the file, choose Bob Example, and create the link. Use **Send email** if the link shows that email has yet to be sent. Open the matching message in Mailpit, then open its link in a separate browser profile and sign in as `bob`. To remove access, revoke the link as Alice and refresh Bob’s page.

The Next.js frontend uses one NestJS API for accounts and file operations. The API records share emails and security alerts in PostgreSQL. A separate `notification-worker` container claims and delivers the queued jobs over SMTP. If the worker stops, file operations stay available and pending jobs can be delivered when it returns. The API, web, migration and worker containers reuse one application image.

## Run on a private Ubuntu VM

On the VM, install Docker Engine and its Compose plugin. From the checkout, generate separate credentials and start the VM profile. Use `sudo docker` in the functions below if your account requires it.

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/app" -w /app \
  node:24-bookworm-slim node scripts/demo-config.mjs --vm --logins

vm_compose() {
  docker compose --env-file .env.vm -p cloud-storage-vm -f compose.yaml \
    -f compose.integrations.yaml -f compose.app.yaml -f compose.demo.yaml -f compose.vm.yaml "$@"
}

vm_compose build api
vm_compose up -d --no-build --wait --wait-timeout 180
vm_compose ps
```

From your workstation, forward the guest's loopback ports `3089` (app), `18089` (sign-in) and `18029` (Mailpit) over SSH. Use `http://localhost:3089` for the app and `http://localhost:18029` for Mailpit. The profile is for private use with synthetic Northstar accounts, Keycloak's development runtime and a captured email inbox. Database, file and identity data live in separate VM volumes. Keep `.env.vm` with the corresponding volumes. Use `vm_compose stop` to stop the app while retaining its data.

## Protected backups and recovery

Recovery snapshots encrypt PostgreSQL metadata and the corresponding file revisions. Prepare a private backup directory and a separate key file outside the checkout. Keep both accessible to the recovery container, which runs as UID 1000. On a deployment, use independent backup storage and protect a recoverable copy of the key separately. Docker access, database credentials, and access to the key are privileged. The operator name must identify an active IT administrator and is recorded in the audit trail.

```sh
export RECOVERY_BACKUP_DIR="$HOME/cloud-storage-backups"
export RECOVERY_KEY_PATH="$HOME/.config/cloud-storage/recovery.key"
export RECOVERY_ACTOR=it-admin
install -d -m 700 "$RECOVERY_BACKUP_DIR" "$(dirname "$RECOVERY_KEY_PATH")"
(umask 077; set -C; openssl rand -hex 32 > "$RECOVERY_KEY_PATH")

recovery_compose() {
  docker compose -f compose.yaml -f compose.integrations.yaml -f compose.app.yaml \
    -f compose.recovery.yaml "$@"
}
```

Generate the key once and keep it for the corresponding snapshots. With the source app running and migrated, build the optional tool, take a snapshot, and check its status.

```sh
recovery_compose build backup
recovery_compose run --rm backup
recovery_compose run --rm backup status
```

Start `recovery_compose up -d backup-schedule` for an immediate backup and subsequent backups every 12 hours by default. The status command checks snapshot age, the gap between the latest two snapshots, manifest authentication, and stored object sizes for the latest snapshot. A restore verifies the authentication tag, size, and SHA-256 of each recovered object. Route the scheduler's unhealthy status and failed-run logs to an operator. Use `recovery_compose logs backup-schedule` for details. Monitor destination free space and manage archive retention according to your organization's approved policy.

### Restore into a fresh instance

Start an empty database under a separate Compose project and choose an unused PostgreSQL port. The restore tool initializes a fresh file volume for that project and requires a matching identity issuer. Keep the target API and notification worker offline during the restore and reuse the same organization issuer for restored accounts. Allow space for the complete set of recovered revisions and the temporary database dump as well as the restored database. To back up the VM profile, add `-f compose.recovery.yaml` to `vm_compose` after `compose.vm.yaml` and use the same private backup directory and key setup.

```sh
recovery_target() {
  POSTGRES_PORT=54330 recovery_compose -p cloud-storage-restore "$@"
}
snapshot_id='paste-the-snapshot-uuid-from-the-backup-output'
recovery_target up -d --wait db
recovery_target run --rm restore restore "$snapshot_id" --actor "$RECOVERY_ACTOR"
```

Review changes between the snapshot and the current organization directory and access records before reopening the service. Include accounts suspended and shares revoked after the backup, and revoke affected links if a membership or permission change would leave restored access too broad. Keep the instance in quarantine if the review is incomplete. For discrepancies, provide an approved JSON file with `suspendEmployees` and `revokeShares` arrays of the corresponding IDs and mount it read-only.

```sh
recovery_target run --rm -v /absolute/path/access-review.json:/run/access-review.json:ro \
  restore resume --actor "$RECOVERY_ACTOR" --access-reviewed --reconcile /run/access-review.json
```

If the completed review finds zero discrepancies, use `recovery_target run --rm restore resume --actor "$RECOVERY_ACTOR" --access-reviewed`. For a local drill using the same app and identity ports, stop the source stack and then start the restored stack with `recovery_target up -d --no-build --wait --wait-timeout 120`. Before routing traffic to the restored instance, verify the restored hashes and confirm current link access with authorized and denied recipients. Keep the source backup audit entry and the target restore and resume entries with the drill record. Record the snapshot point, the data-loss window against the 24-hour target, and elapsed time through service verification against the four-hour recovery target.
