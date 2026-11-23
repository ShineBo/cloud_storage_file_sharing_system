import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException,
} from "@nestjs/common";
import { AuditService, auditItemId, type AuditAttempt } from "../audit/audit.service";
import { DatabaseService } from "../database.service";
import { supportedMimeTypes } from "../files/file-media";

const MAX_QUOTA_BYTES = 20_000_000_000;
const MAX_POLICY_DAYS = 365;
const ALLOWED_MIME_TYPES = [...supportedMimeTypes].sort();

const POLICY_FIELDS = ["allowedMimeTypes", "quotaBytes", "linkExpiryDays", "retentionDays"] as const;
const ACCOUNT_COLUMNS = `id, username, display_name AS "displayName", active,
                         directory_eligible AS "directoryEligible"`;

type Queryable = Pick<DatabaseService, "query">;
type PolicyValues = {
  allowedMimeTypes: string[];
  quotaBytes: number;
  linkExpiryDays: number;
  retentionDays: number;
};
export type StoragePolicy = PolicyValues & { version: number; capacityBytes: number };

type PolicyRow = {
  allowed_mime_types: string[];
  quota_bytes: string | null;
  link_expiry_days: number;
  retention_days: number;
  version: number;
};

type Account = {
  id: string;
  username: string;
  displayName: string;
  active: boolean;
  directoryEligible: boolean;
};

@Injectable()
export class PolicyService {
  private readonly capacityBytes = deploymentCapacity();

  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async read(db: Queryable = this.database, lock = false): Promise<StoragePolicy> {
    return this.toPolicy(await this.readRow(db, lock ? "FOR SHARE" : ""));
  }

  async adminPolicy(adminId: string) {
    return this.database.transaction(async (client) => {
      await this.requireAdmin(adminId, client, true);
      return this.read(client);
    });
  }

  async updatePolicy(adminId: string, input: unknown, event: AuditAttempt) {
    return this.database.transaction(async (client) => {
      await this.requireAdmin(adminId, client, true);
      const patch = policyPatch(input, this.capacityBytes);
      const before = this.toPolicy(await this.readRow(client, "FOR UPDATE"));
      if (patch.version !== before.version) {
        throw new ConflictException("Policy settings changed. Reload them before saving again.");
      }

      const next: PolicyValues = { ...before, ...patch.settings };
      const changes = Object.fromEntries(POLICY_FIELDS.filter((field) =>
        JSON.stringify(next[field]) !== JSON.stringify(before[field]),
      ).map((field) => [field, { from: before[field], to: next[field] }]));
      if (Object.keys(changes).length === 0) return before;

      const updated = (await client.query<PolicyRow>(
        `UPDATE service_policy SET allowed_mime_types = $1,
           quota_bytes = CASE WHEN $2::bigint IS NULL THEN quota_bytes ELSE $2 END,
           link_expiry_days = $3, retention_days = $4, version = version + 1
         WHERE singleton RETURNING allowed_mime_types, quota_bytes, link_expiry_days, retention_days, version`,
        [next.allowedMimeTypes, patch.settings.quotaBytes ?? null, next.linkExpiryDays, next.retentionDays],
      )).rows[0];
      await this.audit.record({ ...event, actorId: adminId, outcome: "success", status: 200, detail: { changes } }, client);
      return this.toPolicy(updated);
    });
  }

  async accounts(adminId: string) {
    return this.database.transaction(async (client) => {
      const issuer = await this.requireAdmin(adminId, client, true);
      const result = await client.query<Account>(
        `SELECT ${ACCOUNT_COLUMNS} FROM employees WHERE issuer = $1 ORDER BY display_name, username, id`,
        [issuer],
      );
      return result.rows;
    });
  }

  async updateAccount(adminId: string, targetId: string, input: unknown, event: AuditAttempt) {
    return this.database.transaction(async (client) => {
      const issuer = await this.requireAdmin(adminId, client);
      const employeeId = auditItemId(targetId);
      if (!employeeId) throw new BadRequestException("Choose a valid employee account.");
      const active = accountStatus(input);
      if (employeeId === adminId && !active) throw new ForbiddenException("You cannot suspend your own account.");

      // Match the ordered employee locks used by file writes and account lifecycle changes.
      const employees = await client.query<Account & { subject: string }>(
        `SELECT ${ACCOUNT_COLUMNS}, subject FROM employees
         WHERE issuer = $1 AND id IN ($2, $3) ORDER BY id FOR NO KEY UPDATE`,
        [issuer, adminId, employeeId],
      );
      await this.requireAdmin(adminId, client, true);
      const before = employees.rows.find(({ id }) => id === employeeId);
      if (!before) throw new NotFoundException("Employee account not found.");
      if (active && !before.directoryEligible) {
        throw new ConflictException("This identity is ineligible in the organization directory.");
      }
      if (before.active === active) return publicAccount(before);

      const { rows: [updated] } = await client.query<Account>(
        `UPDATE employees SET active = $2 WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
        [employeeId, active],
      );
      if (!active) {
        await client.query("DELETE FROM auth_sessions WHERE issuer = $1 AND subject = $2", [issuer, before.subject]);
      }
      await this.audit.record({
        ...event, actorId: adminId, itemId: employeeId, outcome: "success", status: 200,
        detail: { changes: { active: { from: before.active, to: active } } },
      }, client);
      return updated;
    });
  }

  async requireAdmin(adminId: string, db: Queryable = this.database, lock = false) {
    const { rows: [admin] } = await db.query<{ issuer: string }>(
      `SELECT employee.issuer FROM policy_admins AS assignment
       JOIN employees AS employee ON employee.id = assignment.employee_id AND employee.active
       WHERE assignment.employee_id = $1 ${lock ? "FOR SHARE OF employee, assignment" : ""}`,
      [adminId],
    );
    if (!admin) throw new ForbiddenException("IT policy administrator access is required.");
    return admin.issuer;
  }

  private async readRow(db: Queryable, lock: "" | "FOR SHARE" | "FOR UPDATE") {
    const { rows: [row] } = await db.query<PolicyRow>(
      `SELECT allowed_mime_types, quota_bytes, link_expiry_days, retention_days, version
       FROM service_policy WHERE singleton ${lock}`,
    );
    if (!row) throw new ServiceUnavailableException("Storage policy is temporarily unavailable.");
    return row;
  }

  private toPolicy(row: PolicyRow): StoragePolicy {
    return {
      allowedMimeTypes: ALLOWED_MIME_TYPES.filter((type) => row.allowed_mime_types.includes(type)),
      quotaBytes: Math.min(Number(row.quota_bytes ?? this.capacityBytes), this.capacityBytes),
      linkExpiryDays: row.link_expiry_days,
      retentionDays: row.retention_days,
      version: row.version,
      capacityBytes: this.capacityBytes,
    };
  }
}

function accountStatus(value: unknown) {
  const record = objectInput(value);
  if (Object.keys(record).length !== 1 || typeof record.active !== "boolean") {
    throw new BadRequestException("Choose whether the account can access the application.");
  }
  return record.active;
}

function publicAccount({ id, username, displayName, active, directoryEligible }: Account): Account {
  return { id, username, displayName, active, directoryEligible };
}

function policyPatch(value: unknown, capacityBytes: number) {
  const patch = objectInput(value);
  const fields = Object.keys(patch).filter((key) => key !== "version");
  if (fields.length === 0 || fields.some((key) => !POLICY_FIELDS.some((field) => field === key))) {
    throw new BadRequestException("Choose at least one supported policy setting to change.");
  }
  const version = integerSetting(patch.version, 2_147_483_647, "Policy version");
  const settings: Partial<PolicyValues> = {};
  if ("allowedMimeTypes" in patch) settings.allowedMimeTypes = allowedTypes(patch.allowedMimeTypes);
  if ("quotaBytes" in patch) settings.quotaBytes = integerSetting(patch.quotaBytes, capacityBytes, "Quota in bytes");
  if ("linkExpiryDays" in patch) {
    settings.linkExpiryDays = integerSetting(patch.linkExpiryDays, MAX_POLICY_DAYS, "Link expiry in days");
  }
  if ("retentionDays" in patch) {
    settings.retentionDays = integerSetting(patch.retentionDays, MAX_POLICY_DAYS, "Retention in days");
  }
  return { version, settings };
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("Submit policy settings as an object.");
  return value as Record<string, unknown>;
}

function allowedTypes(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > ALLOWED_MIME_TYPES.length ||
      new Set(value).size !== value.length || value.some((type) => !ALLOWED_MIME_TYPES.includes(type))) {
    throw new BadRequestException("Choose one or more of the supported file types.");
  }
  return ALLOWED_MIME_TYPES.filter((type) => value.includes(type));
}

function integerSetting(value: unknown, max: number, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new BadRequestException(`${label} must be a whole number between 1 and ${max}.`);
  }
  return value;
}

function deploymentCapacity() {
  const configured = process.env.FILE_QUOTA_BYTES?.trim();
  if (!configured) return MAX_QUOTA_BYTES;
  const capacity = Number(configured);
  if (!/^\d+$/.test(configured) || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_QUOTA_BYTES) {
    throw new Error(`FILE_QUOTA_BYTES must be a positive integer at most ${MAX_QUOTA_BYTES}.`);
  }
  return capacity;
}
