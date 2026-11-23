import { ForbiddenException, HttpException, Injectable, Logger, ServiceUnavailableException, StreamableFile } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../database.service";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

type AuditItemType = "file" | "folder" | "share" | "policy" | "employee";
type AuditOutcome = "success" | "denied" | "failed";
type Risk = "denied-shared-access" | "inactive-share-access";
export type AuditAction =
  | "upload"
  | "file.update"
  | "folder.create"
  | "folder.update"
  | "share.create"
  | "share.revoke"
  | "share.open"
  | "view"
  | "download"
  | "edit.prepare"
  | "edit"
  | "policy.update"
  | "account.update"
  | "item.delete"
  | "item.restore";

export type AuditAttempt = {
  eventId?: string;
  action: AuditAction;
  actorId: string | null;
  itemType: AuditItemType;
  itemId?: string | null;
  revision?: number | null;
  risk?: Risk;
  detail?: Record<string, unknown>;
};

export type AuditEntry = AuditAttempt & {
  outcome: AuditOutcome;
  status: number;
};

type AuditEventRow = {
  id: string;
  actorId: string | null;
  actorName: string | null;
  itemType: AuditItemType;
  itemId: string | null;
  action: AuditAction;
  outcome: AuditOutcome;
  status: number;
  revision: number | null;
  occurredAt: Date;
  alertRule: Risk | null;
  alertStatus: string | null;
  detail: Record<string, unknown> | null;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly alertRules = new Set(process.env.SECURITY_ALERT_RULES?.split(",").map((rule) => rule.trim()));

  constructor(private readonly database: DatabaseService) {}

  async record(event: AuditEntry, db: Pick<DatabaseService, "query"> = this.database): Promise<void> {
    const itemId = event.itemType === "share" ? null : auditItemId(event.itemId);
    const alertRule = event.outcome === "denied" && event.risk && this.alertRules.has(event.risk)
      ? event.risk : null;
    try {
      // Queue a configured alert only when its original audit record is inserted.
      await db.query(
        `WITH recorded AS (
           INSERT INTO audit_events (
             id, identity_issuer, actor_id, actor_name, item_type, item_id, action, outcome, status, revision, detail
           )
           SELECT $1, COALESCE(actor.issuer, $2), $3, actor.display_name, $4, $5, $6, $7, $8, $9, $11::jsonb
           FROM (VALUES (1)) AS source(value)
           LEFT JOIN employees AS actor ON actor.id = $3
           ON CONFLICT (id) DO NOTHING
           RETURNING id
         )
         INSERT INTO security_alerts (audit_event_id, rule)
         SELECT id, $10::text FROM recorded WHERE $10::text IS NOT NULL
         ON CONFLICT (audit_event_id) DO NOTHING`,
        [
          event.eventId ?? randomUUID(), process.env.OIDC_ISSUER?.trim() || null, event.actorId,
          event.itemType, itemId, event.action, event.outcome, event.status, event.revision ?? null, alertRule,
          event.detail ? JSON.stringify(event.detail) : null,
        ],
      );
    } catch {
      this.logger.error("Could not persist an activity record.");
      throw new ServiceUnavailableException("Activity recording is temporarily unavailable.");
    }
  }

  async run<T>(
    event: AuditAttempt,
    work: (attempt: AuditAttempt) => Promise<T>,
    successStatus: number | null = 200,
  ): Promise<T> {
    event.eventId ??= randomUUID();
    let result: T;
    try {
      result = await work(event);
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 500;
      const outcome = status >= 500 || status === 408 ? "failed" : "denied";
      // Preserve the authorization or workflow response if writing the failed attempt also fails.
      await this.record({ ...event, status, outcome }).catch(() => undefined);
      throw error;
    }
    if (successStatus !== null) {
      try {
        await this.record({ ...event, status: successStatus, outcome: "success" });
      } catch (error) {
        if (result instanceof StreamableFile) result.getStream().destroy();
        throw error;
      }
    }
    return result;
  }

  async recent(reviewerId: string, limit: number, itemId: string | null) {
    const result = await this.database.query<AuditEventRow | { id: null }>(
      `SELECT event.id, event.actor_id AS "actorId", event.actor_name AS "actorName",
              event.item_type AS "itemType", event.item_id AS "itemId", event.action,
              event.outcome, event.status, event.revision, event.occurred_at AS "occurredAt",
              event.detail, alert.rule AS "alertRule", alert.status AS "alertStatus"
       FROM audit_reviewers AS reviewer
       JOIN employees AS employee ON employee.id = reviewer.employee_id AND employee.active
       LEFT JOIN LATERAL (
         SELECT id, actor_id, actor_name, item_type, item_id, action, outcome, status, revision, occurred_at, detail
         FROM audit_events
         WHERE identity_issuer = employee.issuer AND ($3::uuid IS NULL OR item_id = $3)
         ORDER BY occurred_at DESC, id DESC
         LIMIT $2
       ) AS event ON true
       LEFT JOIN security_alerts AS alert ON alert.audit_event_id = event.id
       WHERE reviewer.employee_id = $1
       ORDER BY event.occurred_at DESC, event.id DESC`,
      [reviewerId, limit, itemId],
    );
    if (result.rows.length === 0) throw new ForbiddenException("Audit activity is available to security reviewers.");
    return result.rows.filter((row): row is AuditEventRow => row.id !== null);
  }
}

export function auditItemId(value: unknown) {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}
