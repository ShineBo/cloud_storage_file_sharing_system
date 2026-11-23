import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdtemp, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { checkArchiveSize, decryptArchive, encryptArchive, readArchiveKey, readManifest, writeManifest } from "./recovery-archive.mjs";

const { Client } = pg;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const hour = 60 * 60 * 1000;
const maxBackupAge = 24 * hour;
const manifestName = "manifest.enc";
const dumpName = "database.enc";
const volatileTables = ["auth_sessions", "oidc_login_attempts", "file_upload_reservations", "recovery_state"];
const usage = [
  "backup --actor USER",
  "restore SNAPSHOT_ID --actor USER",
  "resume --actor USER --access-reviewed [--reconcile FILE]",
  "schedule --actor USER",
  "status",
].join(" | ");

class RecoveryError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function requireValue(condition, code, message, status) {
  if (!condition) throw new RecoveryError(code, message, status);
}

function argumentsFor([command, ...args]) {
  const snapshotId = command === "restore" ? args.shift() : undefined;
  const allow = command === "resume" ? ["--actor", "--reconcile", "--access-reviewed"] : ["--actor"];
  const valid = ["backup", "restore", "resume", "schedule", "status"].includes(command)
    && (command !== "restore" || uuid.test(snapshotId))
    && (command !== "status" || args.length === 0);
  requireValue(valid, "usage", usage, 400);
  const options = {};
  while (args.length) {
    const flag = args.shift();
    requireValue(allow.includes(flag) && !(flag in options), "usage", usage, 400);
    options[flag] = flag === "--access-reviewed" ? true : args.shift();
    requireValue(options[flag] && !String(options[flag]).startsWith("--"), "usage", usage, 400);
  }
  requireValue(command === "status" || (options["--actor"]?.trim() && options["--actor"].length <= 255),
    "usage", usage, 400);
  requireValue(command !== "resume" || options["--access-reviewed"], "access-review",
    "Review current account and share access before passing --access-reviewed.", 400);
  return { command, snapshotId, username: options["--actor"], reviewFile: options["--reconcile"] };
}

function env(name) {
  const value = process.env[name]?.trim();
  requireValue(value, "configuration", `${name} must be set.`, 400);
  return value;
}

async function privateDirectory(path) {
  requireValue(isAbsolute(path), "configuration", "Recovery and file storage must use absolute paths.", 400);
  const info = await lstat(path);
  requireValue(info.isDirectory() && (info.mode & 0o077) === 0,
    "directory-permissions", "Use private directories for recovery and file storage.");
  return realpath(path);
}

function containsPath(root, path) {
  const name = relative(root, path);
  return name === "" || (!name.startsWith("../") && name !== ".." && !isAbsolute(name));
}

async function config(command) {
  const root = await privateDirectory(env("RECOVERY_ROOT"));
  const storage = command !== "status" ? await privateDirectory(env("FILE_STORAGE_PATH")) : undefined;
  requireValue(!(storage && (containsPath(root, storage) || containsPath(storage, root))),
    "directory-overlap", "Put protected backups on a separate path from application files.");
  const keyPath = env("RECOVERY_KEY_FILE");
  let key;
  try {
    key = await readArchiveKey(keyPath, [root, ...(storage ? [storage] : [])]);
  } catch {
    throw new RecoveryError("configuration-key",
      "Use a private 64-character hexadecimal key file outside the backup and application file directories.", 400);
  }
  return { root, storage, key, issuer: env("OIDC_ISSUER") };
}

async function synchronizeDirectory(path) {
  const directory = await open(path, "r");
  await directory.sync().finally(() => directory.close());
}

async function withDatabase(work) {
  for (const variable of ["PGHOST", "PGDATABASE", "PGUSER"]) env(variable);
  const db = new Client({ connectionTimeoutMillis: 5_000 });
  db.on("error", () => {});
  try {
    await db.connect();
    const { rows } = await db.query("SELECT pg_try_advisory_lock(213171, 8) AS acquired");
    requireValue(rows[0].acquired, "recovery-busy", "Another recovery operation is running.", 409);
    await db.query("SET lock_timeout = '15s'");
    return await work(db);
  } finally {
    await db.end();
  }
}

async function transaction(db, work, begin = "BEGIN") {
  await db.query(begin);
  try {
    const result = await work();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function actors(db, issuer) {
  const { rows } = await db.query(
    `SELECT employee.id, employee.username, employee.display_name AS "name"
     FROM (
       SELECT id, username, display_name, count(*) OVER (PARTITION BY username) AS matches
       FROM employees WHERE issuer = $1 AND active AND directory_eligible
     ) AS employee
     JOIN policy_admins AS admin ON admin.employee_id = employee.id
     WHERE employee.matches = 1
     ORDER BY employee.id`, [issuer],
  );
  return rows;
}

function requireActor(operators, username) {
  const actor = operators.find((operator) => operator.username === username);
  requireValue(actor, "actor-denied", "The named operator is not an active, eligible policy administrator.", 403);
  return actor;
}

async function audit(db, issuer, actor, id, action, detail, error) {
  const status = error ? error.status ?? 500 : 200;
  await db.query(
    `INSERT INTO audit_events (id, identity_issuer, actor_id, actor_name, item_type, item_id, action, outcome, status, detail)
     VALUES ($1, $2, $3, $4, 'recovery', $5, $6, $7, $8, $9)`,
    [randomUUID(), issuer, actor?.id ?? null, actor?.name ?? null, id, action,
      status === 403 ? "denied" : error ? "failed" : "success", status, detail],
  );
}

async function revisions(db) {
  const { rows } = await db.query(
    `SELECT blob_key AS "key", size_bytes AS "size", sha256 FROM file_revisions ORDER BY blob_key`,
  );
  return rows.map((row) => ({ ...row, size: Number(row.size) }));
}

function descriptor(value) {
  return value && Number.isSafeInteger(value.size) && value.size > 0 &&
    typeof value.sha256 === "string" && hash.test(value.sha256);
}

function time(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function validateManifest(manifest, id, issuer) {
  requireValue(manifest?.format === 1 && manifest.id === id && manifest.issuer === issuer &&
    Number.isFinite(time(manifest.snapshotAt)) && time(manifest.completedAt) >= time(manifest.snapshotAt) &&
    descriptor(manifest.database) &&
    Array.isArray(manifest.operators) && manifest.operators.length > 0 &&
    manifest.operators.every((actor) => uuid.test(actor?.id) && typeof actor.username === "string") &&
    new Set(manifest.operators.map(({ username }) => username)).size === manifest.operators.length &&
    (manifest.createdBy === undefined || manifest.operators.some(({ id }) => id === manifest.createdBy)) &&
    Array.isArray(manifest.blobs) &&
    manifest.blobs.every((blob) => descriptor(blob) && uuid.test(blob.key)) &&
    new Set(manifest.blobs.map(({ key }) => key)).size === manifest.blobs.length,
    "invalid-manifest", "The authenticated manifest does not match this recovery configuration.");
  return manifest;
}

function pgCommand(name, args, stdout, signal) {
  const child = spawn(name, ["--no-password", ...args], {
    stdio: ["ignore", stdout, "ignore"],
    signal,
  });
  const completion = new Promise((resolve) => {
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
  return { child, completion };
}

async function dumpDatabase(snapshot, destination, settings, id, signal) {
  const { child, completion } = pgCommand("pg_dump", [
    "--format=custom", "--no-owner", "--no-privileges", "--lock-wait-timeout=15s",
    `--snapshot=${snapshot}`, ...volatileTables.map((table) => `--exclude-table-data=public.${table}`),
  ], "pipe", signal);
  try {
    const descriptor = await encryptArchive(child.stdout, destination, settings.key, id, "database");
    requireValue(await completion, "pg-dump-failed", "PostgreSQL could not export the recovery snapshot.");
    return descriptor;
  } finally {
    if (child.exitCode === null) child.kill();
    await completion;
  }
}

async function backup(db, { username }, settings, signal) {
  const { root, storage, key, issuer } = settings;
  const id = randomUUID();
  let actor;
  let staging;
  let published = false;
  try {
    // Coordinate schema changes separately from the application's online writes.
    await db.query("SELECT pg_advisory_lock_shared(213171, 2)");
    const manifest = await transaction(db, async () => {
      const { rows: [point] } = await db.query(
        "SELECT statement_timestamp() AS timestamp, pg_export_snapshot() AS exported",
      );
      const { rows: [state] } = await db.query("SELECT blocked FROM recovery_state WHERE singleton");
      requireValue(state?.blocked === false, "recovery-blocked", "Finish recovery before creating a new backup.", 409);
      const operators = await actors(db, issuer);
      actor = requireActor(operators, username);
      const blobs = await revisions(db);
      requireValue(blobs.every(descriptor), "invalid-revision", "A revision has invalid integrity metadata.");
      staging = await mkdtemp(join(root, ".backup-"));
      const database = await dumpDatabase(point.exported, join(staging, dumpName), settings, id, signal);
      // Published revision keys are immutable. Reservations and staged uploads are absent from this snapshot.
      for (const blob of blobs) {
        signal?.throwIfAborted();
        await encryptArchive(join(storage, blob.key), join(staging, `${blob.key}.enc`), key, id, `blob:${blob.key}`, blob);
      }
      const { rows: [{ finished }] } = await db.query("SELECT clock_timestamp() AS finished");
      return {
        format: 1, id, issuer, snapshotAt: point.timestamp.toISOString(), completedAt: finished.toISOString(),
        createdBy: actor.id, operators: operators.map(({ id, username }) => ({ id, username })), database, blobs,
      };
    }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    validateManifest(manifest, id, issuer);
    signal?.throwIfAborted();
    const current = requireActor(await actors(db, issuer), username);
    requireValue(current.id === actor.id, "actor-changed", "The named operator changed during the backup.", 403);
    await writeManifest(join(staging, manifestName), key, id, manifest);
    await synchronizeDirectory(staging);
    await rename(staging, join(root, id));
    published = true;
    await synchronizeDirectory(root);
    const detail = { snapshotAt: manifest.snapshotAt, completedAt: manifest.completedAt, revisionCount: manifest.blobs.length };
    await audit(db, issuer, actor, id, "recovery.backup", detail);
    return { snapshotId: id, ...detail };
  } catch (error) {
    if (published) {
      throw new RecoveryError("backup-published", `Backup ${id} was published. Its durability or audit record could not be confirmed.`);
    }
    const reason = error instanceof RecoveryError ? error.code : "backup-io-failed";
    if (actor || reason === "actor-denied") {
      await audit(db, issuer, actor, id, "recovery.backup", { reason }, error).catch(() => {});
    }
    throw error instanceof RecoveryError ? error :
      new RecoveryError(reason, "Backup did not publish. Check PostgreSQL, file storage, the key and archive permissions, and available space.");
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

async function emptyDatabase(db) {
  const { rows: [{ empty }] } = await db.query(
    `SELECT NOT (
       EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_')
       OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace)
       OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace)
       OR EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace)
       OR EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql')
     ) AS empty`,
  );
  return empty;
}

async function loadSnapshot(id, { root, key, issuer }) {
  try {
    const path = await privateDirectory(join(root, id));
    const manifest = validateManifest(await readManifest(join(path, manifestName), key, id), id, issuer);
    return { path, manifest };
  } catch {
    throw new RecoveryError("snapshot-unavailable", "The snapshot manifest could not be authenticated for this configuration.", 400);
  }
}

async function restore(db, { snapshotId: id, username, startedAt }, settings) {
  const { storage, key, issuer } = settings;
  const { path, manifest } = await loadSnapshot(id, settings);
  const checkpointOperator = requireActor(manifest.operators, username);
  requireValue(time(manifest.snapshotAt) <= startedAt.getTime(), "clock-mismatch",
    "The snapshot time is in the future. Check the clocks on the backup and restore hosts.", 400);
  // A restore owns the migration lock until the recovered database has a quarantine record.
  await db.query("SELECT pg_advisory_lock(213171, 2)");
  requireValue(await emptyDatabase(db), "target-database-not-empty", "Restore requires a new, empty target database.", 409);
  requireValue((await readdir(storage)).length === 0,
    "target-files-not-empty", "Restore requires an empty target file volume.", 409);
  const staging = await mkdtemp(join(storage, ".restore-"));
  const installed = [];
  let keepFiles = false;

  try {
    const dump = join(staging, "database.dump");
    await decryptArchive(join(path, dumpName), dump, key, id, "database", manifest.database);
    for (const blob of manifest.blobs) {
      await decryptArchive(join(path, `${blob.key}.enc`), join(staging, blob.key), key, id, `blob:${blob.key}`, blob);
    }
    requireValue(await emptyDatabase(db), "target-database-not-empty", "The target database changed during restore.", 409);
    requireValue((await readdir(storage)).length === 1, "target-files-not-empty", "The target file volume changed during restore.", 409);
    for (const { key } of manifest.blobs) {
      const destination = join(storage, key);
      await link(join(staging, key), destination);
      installed.push(destination);
    }
    await synchronizeDirectory(storage);

    // Keep installed blobs if the database commit cannot be ruled out.
    keepFiles = true;
    const { completion } = pgCommand("pg_restore", [
      "--dbname", env("PGDATABASE"), "--single-transaction", "--exit-on-error", "--no-owner", "--no-privileges", dump,
    ], "ignore");
    if (!(await completion)) {
      keepFiles = !(await emptyDatabase(db).catch(() => false));
      throw new RecoveryError("pg-restore-failed", keepFiles
        ? "PostgreSQL restore could not be confirmed. Keep the target quarantined for inspection."
        : "PostgreSQL rejected the restore. The empty target can be used for another attempt.");
    }

    return await transaction(db, async () => {
      const actor = requireActor(await actors(db, issuer), username);
      requireValue(actor.id === checkpointOperator.id, "actor-mismatch", "The recovered operator does not match the checkpoint.", 403);
      const restored = await revisions(db);
      const expected = new Map(manifest.blobs.map((blob) => [blob.key, blob]));
      requireValue(restored.length === expected.size && restored.every((blob) => {
        const entry = expected.get(blob.key);
        return entry?.size === blob.size && entry.sha256 === blob.sha256;
      }), "metadata-mismatch", "The restored revision records do not match the checkpoint.");
      const restoredAt = new Date();
      const detail = {
        snapshotAt: manifest.snapshotAt, restoreStartedAt: startedAt.toISOString(), restoredAt: restoredAt.toISOString(),
        revisionCount: restored.length, recoveryPointAgeMs: startedAt.getTime() - time(manifest.snapshotAt),
        restoreDurationMs: restoredAt.getTime() - startedAt.getTime(), backupCompletedAt: manifest.completedAt,
        backupActorId: manifest.createdBy,
      };
      await db.query(
        "INSERT INTO recovery_state (singleton, blocked, backup_id, restored_at) VALUES (true, true, $1, $2)", [id, restoredAt],
      );
      await audit(db, issuer, actor, id, "recovery.restore", detail);
      return { snapshotId: id, blocked: true, ...detail };
    });
  } catch (error) {
    if (keepFiles) throw new RecoveryError("restore-unconfirmed",
      "Files were installed. Keep the target quarantined until the database and restore audit are inspected.");
    throw error instanceof RecoveryError ? error :
      new RecoveryError("restore-data-invalid", "Restore did not write to PostgreSQL. Check the protected archive and available storage.");
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (!keepFiles) {
      for (const path of installed) await rm(path, { force: true });
      await synchronizeDirectory(storage);
    }
  }
}

async function readReview(path) {
  if (!path) return { employees: [], shares: [] };
  let value;
  try {
    const file = await lstat(path);
    requireValue(file.isFile() && file.size <= 1024 * 1024, "review-format", "Use a review JSON file no larger than 1 MiB.", 400);
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new RecoveryError("review-format", "Use a review JSON file no larger than 1 MiB.", 400);
  }
  requireValue(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => ["suspendEmployees", "revokeShares"].includes(key)),
    "review-format", "Use suspendEmployees and revokeShares arrays of UUIDs.", 400);
  const employees = Object.hasOwn(value, "suspendEmployees") ? value.suspendEmployees : [];
  const shares = Object.hasOwn(value, "revokeShares") ? value.revokeShares : [];
  for (const ids of [employees, shares]) {
    requireValue(Array.isArray(ids) && ids.every((id) => typeof id === "string" && uuid.test(id))
      && new Set(ids).size === ids.length, "review-format", "Use unique UUIDs in the review arrays.", 400);
  }
  return { employees, shares };
}

async function resume(db, { username, reviewFile }, settings) {
  const { issuer, storage } = settings;
  const { employees, shares } = await readReview(reviewFile);
  return transaction(db, async () => {
    const actor = requireActor(await actors(db, issuer), username);
    const { rows: [state] } = await db.query(
      "SELECT blocked, backup_id FROM recovery_state WHERE singleton FOR UPDATE",
    );
    requireValue(state?.blocked && state.backup_id, "not-reviewable",
      "Complete a verified restore before reopening access.", 409);
    const { manifest } = await loadSnapshot(state.backup_id, settings);
    const { rows: [drill] } = await db.query(
      `SELECT detail->>'restoreStartedAt' AS started, detail->>'snapshotAt' AS snapshot
       FROM audit_events WHERE item_id = $1 AND item_type = 'recovery' AND action = 'recovery.restore' AND outcome = 'success'
       ORDER BY occurred_at DESC LIMIT 1`, [state.backup_id],
    );
    requireValue(Number.isFinite(time(drill?.started)) && drill.snapshot === manifest.snapshotAt,
      "restore-audit-missing", "The restore audit record does not match the authenticated checkpoint.");
    try {
      for (const blob of manifest.blobs) {
        const file = await lstat(join(storage, blob.key));
        if (!file.isFile() || file.size !== blob.size) throw new Error("Recovered file differs from the checkpoint.");
      }
    } catch {
      throw new RecoveryError("restored-file-missing", "Check the restored file volume before reopening access.", 409);
    }
    requireValue(!employees.includes(actor.id), "review-operator", "Have another active administrator review this suspension.", 400);
    const changedEmployees = await db.query(
      "UPDATE employees SET active = false WHERE issuer = $1 AND id = ANY($2::uuid[])", [issuer, employees],
    );
    const changedShares = await db.query(
      "UPDATE shares SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE issuer = $1 AND id = ANY($2::uuid[])",
      [issuer, shares],
    );
    requireValue(changedEmployees.rowCount === employees.length && changedShares.rowCount === shares.length,
      "review-target", "Each review ID must exist in the restored issuer.", 400);
    await db.query(`
      DELETE FROM auth_sessions;
      DELETE FROM oidc_login_attempts;
      DELETE FROM file_upload_reservations;
      UPDATE share_delivery_attempts SET status = 'failed', finished_at = clock_timestamp(),
        failure_code = 'recovery-interrupted' WHERE status = 'sending';
      UPDATE share_deliveries SET status = 'failed', claim_id = NULL, claim_until = NULL
        WHERE status IN ('pending', 'sending');
      UPDATE security_alerts SET status = 'failed', finished_at = clock_timestamp(), claim_id = NULL, claim_until = NULL
        WHERE status IN ('pending', 'sending');
    `);
    const resumedAt = new Date();
    const detail = { resumedAt: resumedAt.toISOString(), recoveryTimeMs: resumedAt.getTime() - time(drill.started) };
    await audit(db, issuer, actor, state.backup_id, "recovery.resume", {
      ...detail, suspendedEmployeeIds: employees, revokedShareIds: shares,
    });
    await db.query("UPDATE recovery_state SET blocked = false WHERE singleton");
    return {
      snapshotId: state.backup_id, blocked: false, ...detail, suspendedEmployees: employees.length, revokedShares: shares.length,
    };
  });
}

async function status({ root, key, issuer }) {
  let corruptSnapshots = 0;
  let latest;
  let previous;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!uuid.test(entry.name)) continue;
    try {
      const path = await privateDirectory(join(root, entry.name));
      const manifest = validateManifest(await readManifest(join(path, manifestName), key, entry.name), entry.name, issuer);
      await checkArchiveSize(join(path, dumpName), manifest.database.size);
      if (!latest || time(manifest.snapshotAt) >= time(latest.manifest.snapshotAt)) {
        previous = latest?.manifest.snapshotAt;
        latest = { path, manifest };
      } else if (!previous || time(manifest.snapshotAt) > time(previous)) {
        previous = manifest.snapshotAt;
      }
    } catch {
      corruptSnapshots++;
    }
  }
  if (latest) {
    const { path, manifest: { blobs } } = latest;
    try {
      // Monitoring only checks the latest revision object sizes. Restore authenticates and hashes their bytes.
      for (let i = 0; i < blobs.length; i += 32) {
        await Promise.all(blobs.slice(i, i + 32).map(({ key, size }) => checkArchiveSize(join(path, `${key}.enc`), size)));
      }
    } catch {
      corruptSnapshots++;
    }
  }
  const checkpoint = latest?.manifest;
  const snapshotAgeMs = checkpoint ? Date.now() - time(checkpoint.snapshotAt) : null;
  const backupGapMs = previous ? time(checkpoint.snapshotAt) - time(previous) : null;
  const healthy = snapshotAgeMs !== null && snapshotAgeMs >= 0 && snapshotAgeMs <= maxBackupAge &&
    (backupGapMs === null || backupGapMs <= maxBackupAge) && corruptSnapshots === 0;
  if (!healthy) process.exitCode = 1;
  return {
    healthy, snapshotId: checkpoint?.id ?? null, snapshotAt: checkpoint?.snapshotAt ?? null,
    completedAt: checkpoint?.completedAt ?? null, snapshotAgeMs, backupGapMs, corruptSnapshots,
  };
}

function reportError(error) {
  const failure = error instanceof RecoveryError ? error :
    new RecoveryError("recovery-unavailable", "Recovery could not continue. Check the configured database, key, and private storage.");
  console.error(JSON.stringify({ error: failure.code, message: failure.message }));
}

async function schedule(options, settings) {
  const interval = Number(process.env.RECOVERY_INTERVAL_HOURS ?? 12);
  requireValue(Number.isFinite(interval) && interval > 0 && interval <= 24,
    "schedule-interval", "RECOVERY_INTERVAL_HOURS must be greater than 0 and at most 24.", 400);
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  while (!stop.signal.aborted) {
    const started = Date.now();
    try {
      console.log(JSON.stringify(await withDatabase((db) => backup(db, options, settings, stop.signal))));
    } catch (error) {
      if (!stop.signal.aborted) reportError(error);
    }
    if (!stop.signal.aborted) {
      await delay(Math.max(1, interval * hour - (Date.now() - started)), undefined, { signal: stop.signal }).catch(() => {});
    }
  }
}

try {
  const startedAt = new Date();
  const options = argumentsFor(process.argv.slice(2));
  const settings = await config(options.command);
  if (options.command === "schedule") {
    await schedule(options, settings);
  } else {
    const result = options.command === "status" ? await status(settings) :
      await withDatabase((db) => ({ backup, restore, resume })[options.command](db, { ...options, startedAt }, settings));
    console.log(JSON.stringify(result));
  }
} catch (error) {
  reportError(error);
  process.exitCode = 1;
}
