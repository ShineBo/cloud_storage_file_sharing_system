import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { OidcService } from "../auth/oidc.service";
import { DatabaseService } from "../database.service";
import { LIVE_SHARE_TARGET } from "../shares/live-share-target";
import { readMailbox, SmtpService } from "./smtp.service";

export type ShareDelivery = {
  status: "not_sent" | "pending" | "sent" | "failed" | "partial";
  sent: number;
  total: number;
};

type Queryable = Pick<DatabaseService, "query">;
type ShareJob = { id: string; share_id: string; recipient_id: string; claim_id: string | null };
type AlertJob = { audit_event_id: string; attempt_count: number; rule: string };
type Recipient = {
  notification_email: string | null;
  sender_name: string;
  permission: "view" | "edit";
  expires_at: Date;
};
type AuditDetails = {
  action: string;
  status: number;
  actor_id: string | null;
  item_type: string;
  item_id: string | null;
  occurred_at: Date;
};

const IDLE_POLL_MS = 750;
const ACTIVE_POLL_MS = 50;
const ALERT_ATTEMPT_LIMIT = 4;
const LEASE = "interval '2 minutes'";

const ELIGIBLE_RECIPIENTS = `
  SELECT recipient.id AS recipient_id, recipient.notification_email, sender.display_name AS sender_name,
         share.issuer, share.permission, share.expires_at
  FROM shares AS share
  JOIN employees AS sender ON sender.id = share.owner_id AND sender.active
  JOIN employees AS recipient ON recipient.issuer = share.issuer AND recipient.active
  WHERE share.id = $1 AND share.revoked_at IS NULL AND share.expires_at > clock_timestamp()
    AND ${LIVE_SHARE_TARGET}
    AND (share.recipient_employee_id = recipient.id OR EXISTS (
      SELECT 1 FROM internal_group_members AS member
      JOIN internal_groups AS team ON team.id = member.group_id AND team.approved
      WHERE member.group_id = share.recipient_group_id AND member.employee_id = recipient.id
    ))
`;

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly oidc: OidcService,
    private readonly smtp: SmtpService,
  ) {}

  onModuleInit() {
    this.schedule(IDLE_POLL_MS);
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  async queueShare(client: PoolClient, shareId: string) {
    await client.query("INSERT INTO share_delivery_requests (share_id) VALUES ($1) ON CONFLICT DO NOTHING", [shareId]);
    await client.query(
      `INSERT INTO share_deliveries (share_id, recipient_id)
       SELECT $1, candidate.recipient_id FROM (${ELIGIBLE_RECIPIENTS}) AS candidate
       WHERE NOT EXISTS (SELECT 1 FROM share_deliveries WHERE share_id = $1)
       ON CONFLICT (share_id, recipient_id) DO NOTHING`,
      [shareId],
    );
  }

  async retryShare(client: PoolClient, shareId: string) {
    await this.queueShare(client, shareId);
    await client.query(
      `UPDATE share_deliveries AS delivery SET status = 'pending', queued_at = clock_timestamp()
       FROM (${ELIGIBLE_RECIPIENTS}) AS candidate
       WHERE delivery.share_id = $1 AND delivery.recipient_id = candidate.recipient_id AND delivery.status = 'failed'`,
      [shareId],
    );
  }

  async shareStatus(db: Queryable, ids: string[]) {
    const statuses = new Map<string, ShareDelivery>(ids.map((id) => [id, { status: "not_sent", sent: 0, total: 0 }]));
    if (ids.length === 0) return statuses;
    const result = await db.query<ShareDelivery & { share_id: string }>(
      "SELECT share_id, status, sent, total FROM share_delivery_status WHERE share_id = ANY($1::uuid[])",
      [ids],
    );
    for (const { share_id, status, sent, total } of result.rows) statuses.set(share_id, { status, sent, total });
    return statuses;
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.process();
    }, delay);
    this.timer.unref();
  }

  private async process() {
    const results = await Promise.allSettled([this.deliverShare(), this.deliverAlert()]);
    if (results.some((result) => result.status === "rejected")) {
      this.logger.warn("A notification queue could not be processed. Work will resume on the next poll.");
    }
    const worked = results.some((result) => result.status === "fulfilled" && result.value);
    this.schedule(worked ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }

  private async deliverShare() {
    const claimId = randomUUID();
    const job = await this.claimShare(claimId);
    if (!job) return false;

    let failure: string | null = null;
    const recipient = (await this.database.query<Recipient>(
      `SELECT notification_email, sender_name, permission, expires_at
       FROM (${ELIGIBLE_RECIPIENTS}) AS candidate WHERE candidate.recipient_id = $2 AND candidate.issuer = $3`,
      [job.share_id, job.recipient_id, process.env.OIDC_ISSUER?.trim() || null],
    )).rows[0];
    const email = readMailbox(recipient?.notification_email);
    if (!recipient || !email) {
      failure = recipient ? "missing-address" : "inactive-share-or-recipient";
    } else {
      try {
        const url = new URL(`/shared/${job.share_id}`, this.oidc.applicationOrigin);
        const sender = recipient.sender_name.replace(/\s+/g, " ").trim();
        const notice = [
          `${sender} shared an item with you in Cloud Storage.`,
          `Open it with your organization account: ${url.href}`,
          `Permission: ${recipient.permission}. Expires: ${recipient.expires_at.toISOString()}.`,
        ].join("\n\n");
        await this.smtp.send(email, "A Cloud Storage item was shared with you", notice, `share-notice-${job.id}`);
      } catch {
        failure = "smtp-unavailable";
      }
    }

    await this.database.transaction(async (client) => {
      const status = failure ? "failed" : "sent";
      const updated = await client.query(
        `UPDATE share_deliveries SET status = $3, claim_id = NULL, claim_until = NULL
         WHERE id = $1 AND claim_id = $2`,
        [job.id, claimId, status],
      );
      if (updated.rowCount) {
        await client.query(
          `UPDATE share_delivery_attempts SET status = $2, failure_code = $3, finished_at = clock_timestamp() WHERE id = $1`,
          [claimId, status, failure],
        );
      }
    });
    return true;
  }

  private async claimShare(claimId: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query<ShareJob>(
        `SELECT id, share_id, recipient_id, claim_id FROM share_deliveries
         WHERE status = 'pending' OR (status = 'sending' AND claim_until <= clock_timestamp())
         ORDER BY queued_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const job = result.rows[0];
      if (!job) return undefined;
      if (job.claim_id) {
        await client.query(
          `UPDATE share_delivery_attempts SET status = 'failed', failure_code = 'worker-interrupted',
             finished_at = clock_timestamp() WHERE id = $1`,
          [job.claim_id],
        );
      }
      await client.query(
        `UPDATE share_deliveries SET status = 'sending', claim_id = $2, claim_until = clock_timestamp() + ${LEASE}
         WHERE id = $1`,
        [job.id, claimId],
      );
      await client.query("INSERT INTO share_delivery_attempts (id, delivery_id) VALUES ($1, $2)", [claimId, job.id]);
      return job;
    });
  }

  private async deliverAlert() {
    const claimId = randomUUID();
    const job = await this.claimAlert(claimId);
    if (!job) return false;
    const destination = readMailbox(process.env.SECURITY_ALERT_TO);
    const details = (await this.database.query<AuditDetails>(
      `SELECT action, status, actor_id, item_type, item_id, occurred_at FROM audit_events
       WHERE id = $1 AND identity_issuer = $2`,
      [job.audit_event_id, process.env.OIDC_ISSUER?.trim() || null],
    )).rows[0];

    let sent = false;
    if (destination && details) {
      try {
        const reference = new URL("/api/audit", this.oidc.applicationOrigin);
        const notice = [
          `Rule: ${job.rule}`,
          `Audit event: ${job.audit_event_id}`,
          `Action: ${details.action} (${details.status})`,
          `Actor: ${details.actor_id ?? "unidentified"}`,
          `Item: ${details.item_type}${details.item_id ? ` ${details.item_id}` : ""}`,
          `Time: ${details.occurred_at.toISOString()}`,
          `Review activity with your security account: ${reference.href}`,
        ].join("\n");
        await this.smtp.send(destination, "[Security] Cloud Storage alert", notice, `security-notice-${job.audit_event_id}`);
        sent = true;
      } catch {
        // SMTP handoff is retried using the same audit event and message ID.
      }
    }
    const retry = !sent && Boolean(destination && details) && job.attempt_count < ALERT_ATTEMPT_LIMIT;
    await this.database.query(
      `UPDATE security_alerts SET status = $3, claim_id = NULL, claim_until = NULL,
         finished_at = CASE WHEN $3 = 'pending' THEN NULL ELSE clock_timestamp() END,
         next_attempt_at = clock_timestamp() + $4::integer * interval '1 second'
       WHERE audit_event_id = $1 AND claim_id = $2`,
      [job.audit_event_id, claimId, sent ? "sent" : retry ? "pending" : "failed", 5 * 3 ** (job.attempt_count - 1)],
    );
    return true;
  }

  private async claimAlert(claimId: string) {
    return this.database.transaction(async (client) => {
      await client.query(
        `UPDATE security_alerts SET status = 'failed', claim_id = NULL, claim_until = NULL, finished_at = clock_timestamp()
         WHERE status = 'sending' AND claim_until <= clock_timestamp() AND attempt_count >= $1`,
        [ALERT_ATTEMPT_LIMIT],
      );
      const result = await client.query<AlertJob>(
        `WITH candidate AS (
           SELECT audit_event_id FROM security_alerts
           WHERE attempt_count < $2 AND ((status = 'pending' AND next_attempt_at <= clock_timestamp())
             OR (status = 'sending' AND claim_until <= clock_timestamp()))
           ORDER BY next_attempt_at, audit_event_id LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         UPDATE security_alerts AS alert SET status = 'sending', attempt_count = attempt_count + 1,
           claim_id = $1, claim_until = clock_timestamp() + ${LEASE}
         FROM candidate WHERE alert.audit_event_id = candidate.audit_event_id
         RETURNING alert.audit_event_id, alert.rule, alert.attempt_count`,
        [claimId, ALERT_ATTEMPT_LIMIT],
      );
      return result.rows[0];
    });
  }
}
