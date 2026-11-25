import { ForbiddenException, HttpException, Injectable, Logger, ServiceUnavailableException, StreamableFile } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../database.service";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

type AuditItemType = "file" | "folder" | "share" | "policy" | "employee" | "recovery";
export const auditOutcomes = ["success", "denied", "failed"] as const;
export const auditAlertFilters = ["present", "pending", "sending", "sent", "failed"] as const;
type AuditOutcome = typeof auditOutcomes[number];
type AuditAlertFilter = typeof auditAlertFilters[number];
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
  | "item.restore"
  | "recovery.backup"
  | "recovery.restore"
  | "recovery.resume";

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

type AuditFilters = {
  limit: number;
  itemId: string | null;
  searchId: string | null;
  after: string | null;
  outcome: AuditOutcome | null;
  alert: AuditAlertFilter | null;
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

  async recent(reviewerId: string, { limit, itemId, searchId, after, outcome, alert }: AuditFilters) {
    const result = await this.database.query<AuditEventRow | { id: null }>(
      `SELECT event.id, event.actor_id AS "actorId", event.actor_name AS "actorName",
              event.item_type AS "itemType", event.item_id AS "itemId", event.action,
              event.outcome, event.status, event.revision, event.occurred_at AS "occurredAt",
              event.detail, event.alert_rule AS "alertRule", event.alert_status AS "alertStatus"
       FROM audit_reviewers AS reviewer
       JOIN employees AS employee ON employee.id = reviewer.employee_id AND employee.active
       LEFT JOIN audit_events AS anchor ON anchor.id = $5::uuid AND anchor.identity_issuer = employee.issuer
       LEFT JOIN LATERAL (
         SELECT activity.*, notification.rule AS alert_rule, notification.status AS alert_status
         FROM audit_events AS activity
         LEFT JOIN security_alerts AS notification ON notification.audit_event_id = activity.id
         WHERE activity.identity_issuer = employee.issuer
           AND ($3::uuid IS NULL OR activity.item_id = $3)
           AND ($4::uuid IS NULL OR $4 IN (activity.id, activity.item_id, activity.actor_id))
           AND ($5::uuid IS NULL OR (activity.occurred_at, activity.id) < (anchor.occurred_at, anchor.id))
           AND ($6::text IS NULL OR activity.outcome = $6)
           AND ($7::text IS NULL OR notification.status = $7 OR ($7 = 'present' AND notification.audit_event_id IS NOT NULL))
         ORDER BY activity.occurred_at DESC, activity.id DESC
         LIMIT ($2::integer + 1)
       ) AS event ON true
       WHERE reviewer.employee_id = $1
       ORDER BY event.occurred_at DESC, event.id DESC`,
      [reviewerId, limit, itemId, searchId, after, outcome, alert],
    );
    if (result.rows.length === 0) throw new ForbiddenException("Audit activity is available to security reviewers.");
    const events = result.rows.filter((row): row is AuditEventRow => row.id !== null);
    const nextCursor = events.length > limit ? events[limit - 1].id : null;
    return { events: events.slice(0, limit), nextCursor };
  }
}

export function auditItemId(value: unknown) {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}
