import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const migrations = new URL("../apps/api/migrations/", import.meta.url);

async function seedClassDirectory(db) {
  if (!process.env.OIDC_ISSUER) throw new Error("OIDC_ISSUER is required to seed the demo directory.");

  const file = new URL("../fixtures/keycloak/se-final-class-realm.json", import.meta.url);
  const { users } = JSON.parse(await readFile(file, "utf8"));
  for (const user of users) {
    if (user.username === "eve") continue;

    const eligible = user.username !== "dana";
    await db.query(
      `INSERT INTO employees (id, issuer, subject, username, display_name, active, notification_email, directory_eligible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $6)
       ON CONFLICT (issuer, subject) DO UPDATE
       SET notification_email = EXCLUDED.notification_email
       WHERE employees.notification_email IS NULL`,
      [randomUUID(), process.env.OIDC_ISSUER, user.id, user.username,
        `${user.firstName} ${user.lastName}`, eligible, user.email ?? null],
    );
  }

  const policyAdmin = users.find(({ username }) => username === "it-admin");
  if (policyAdmin) {
    await db.query(
      `INSERT INTO policy_admins (employee_id)
       SELECT id FROM employees WHERE issuer = $1 AND subject = $2
       ON CONFLICT DO NOTHING`,
      [process.env.OIDC_ISSUER, policyAdmin.id],
    );
  }

  const securityReviewer = users.find(({ username }) => username === "security-reviewer");
  if (securityReviewer) {
    await db.query(
      `INSERT INTO audit_reviewers (employee_id)
       SELECT id FROM employees WHERE issuer = $1 AND subject = $2
       ON CONFLICT DO NOTHING`,
      [process.env.OIDC_ISSUER, securityReviewer.id],
    );
  }

  const createdGroup = await db.query(
    `INSERT INTO internal_groups (id, issuer, name, approved)
     VALUES ($1, $2, 'Design Team', true)
     ON CONFLICT (issuer, name) DO NOTHING
     RETURNING id`,
    [randomUUID(), process.env.OIDC_ISSUER],
  );
  const group = createdGroup.rows[0];
  if (group) {
    const memberSubjects = users.filter(({ username }) => username === "bob" || username === "priya")
      .map(({ id }) => id);
    await db.query(
      `INSERT INTO internal_group_members (issuer, group_id, employee_id)
       SELECT issuer, $2, id FROM employees WHERE issuer = $1 AND subject = ANY($3::text[])`,
      [process.env.OIDC_ISSUER, group.id, memberSubjects],
    );
  }
}

const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
await db.connect();
try {
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(213171, 2)");
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)");
  const applied = await db.query("SELECT name FROM schema_migrations");
  const appliedNames = new Set(applied.rows.map(({ name }) => name));
  const files = (await readdir(migrations)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();

  for (const name of files) {
    if (appliedNames.has(name)) continue;
    await db.query(await readFile(new URL(name, migrations), "utf8"));
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
  }

  if (process.argv.includes("--class-fixtures")) await seedClassDirectory(db);
  await db.query("COMMIT");
  console.log("Database migrations are ready.");
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
} finally {
  await db.end();
}
