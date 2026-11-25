import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { DatabaseService } from "../database.service";
import { readNotificationOrigin } from "./notification-origin";
import { ELIGIBLE_RECIPIENTS } from "./notification.service";
import { readMailbox, SmtpService } from "./smtp.service";

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

const RECOVERY_READY = "EXISTS (SELECT 1 FROM recovery_state WHERE singleton AND NOT blocked)";
const HEARTBEAT_PATH = "/tmp/cloud-notification-worker.heartbeat";
const HEARTBEAT_INTERVAL_MS = 3000;

@Injectable()
export class NotificationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationWorkerService.name);
  private readonly issuer = process.env.OIDC_ISSUER?.trim();
  private readonly applicationOrigin = readNotificationOrigin();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private heartbeatAt = 0;
  private pollFailed = false;

  constructor(private readonly database: DatabaseService, private readonly smtp: SmtpService) {}

  async onModuleInit() {
    if (!this.issuer) throw new Error("OIDC_ISSUER is required to scope notification delivery.");
    await rm(HEARTBEAT_PATH, { force: true });
    this.schedule(0);
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    await this.clearHeartbeat();
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.process();
    }, delay);
  }

  private async process() {
    let nextDelay = IDLE_POLL_MS;
    try {
      if (!(await this.database.isReady()) || this.stopped) {
        await this.clearHeartbeat();
        return;
      }
      const results = await Promise.allSettled([this.deliverShare(), this.deliverAlert()]);
      if (results.some((result) => result.status === "rejected")) throw new Error("Notification poll failed.");

      if (await this.database.isReady() && !this.stopped) {
        await this.refreshHeartbeat();
      } else {
        await this.clearHeartbeat();
      }
      this.pollFailed = false;
      if (results.some((result) => result.status === "fulfilled" && result.value)) nextDelay = ACTIVE_POLL_MS;
    } catch {
      if (!this.pollFailed) {
        this.logger.warn("The notification worker could not complete a poll. It will retry.");
        this.pollFailed = true;
      }
      await this.clearHeartbeat().catch(() => undefined);
    } finally {
      this.schedule(nextDelay);
    }
  }

  private async refreshHeartbeat() {
    const now = Date.now();
    if (now - this.heartbeatAt < HEARTBEAT_INTERVAL_MS) return;
    await writeFile(HEARTBEAT_PATH, "ready\n", {
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      mode: 0o600,
    });
    this.heartbeatAt = now;
  }

  private async clearHeartbeat() {
    if (!this.heartbeatAt) return;
    await rm(HEARTBEAT_PATH, { force: true });
    this.heartbeatAt = 0;
  }

  private async deliverShare() {
    const claimId = randomUUID();
    const job = await this.claimShare(claimId);
    if (!job) return false;

    let failure: string | null = null;
    const recipient = (await this.database.query<Recipient>(
      `SELECT candidate.notification_email, candidate.sender_name, candidate.permission, candidate.expires_at
       FROM (${ELIGIBLE_RECIPIENTS}) AS candidate
       JOIN share_deliveries AS delivery ON delivery.id = $4
       WHERE candidate.recipient_id = $2 AND candidate.issuer = $3
         AND delivery.claim_id = $5 AND delivery.claim_until > clock_timestamp() AND ${RECOVERY_READY}`,
      [job.share_id, job.recipient_id, this.issuer, job.id, claimId],
    )).rows[0];
    if (!recipient && !(await this.database.isReady())) return false;
    const email = readMailbox(recipient?.notification_email);
    if (!recipient || !email) {
      failure = recipient ? "missing-address" : "inactive-share-or-recipient";
    } else {
      try {
        const url = new URL(`/shared/${job.share_id}`, this.applicationOrigin);
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
        `SELECT delivery.id, delivery.share_id, delivery.recipient_id, delivery.claim_id
         FROM share_deliveries AS delivery
         JOIN shares AS share ON share.id = delivery.share_id AND share.issuer = $1
         WHERE ${RECOVERY_READY} AND (delivery.status = 'pending'
           OR (delivery.status = 'sending' AND delivery.claim_until <= clock_timestamp()))
         ORDER BY delivery.queued_at, delivery.id LIMIT 1 FOR UPDATE OF delivery SKIP LOCKED`,
        [this.issuer],
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
      `SELECT event.action, event.status, event.actor_id, event.item_type, event.item_id, event.occurred_at
       FROM audit_events AS event
       JOIN security_alerts AS alert ON alert.audit_event_id = event.id
       WHERE event.id = $1 AND event.identity_issuer = $2
         AND alert.claim_id = $3 AND alert.claim_until > clock_timestamp() AND ${RECOVERY_READY}`,
      [job.audit_event_id, this.issuer, claimId],
    )).rows[0];
    if (!details && !(await this.database.isReady())) return false;

    let sent = false;
    if (destination && details) {
      try {
        const reference = new URL("/security", this.applicationOrigin);
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
        `UPDATE security_alerts AS alert
         SET status = 'failed', claim_id = NULL, claim_until = NULL, finished_at = clock_timestamp()
         WHERE ${RECOVERY_READY} AND alert.status = 'sending' AND alert.claim_until <= clock_timestamp()
           AND alert.attempt_count >= $1 AND EXISTS (
             SELECT 1 FROM audit_events AS event WHERE event.id = alert.audit_event_id AND event.identity_issuer = $2
           )`,
        [ALERT_ATTEMPT_LIMIT, this.issuer],
      );
      const result = await client.query<AlertJob>(
        `WITH candidate AS (
           SELECT candidate_alert.audit_event_id FROM security_alerts AS candidate_alert
           JOIN audit_events AS event ON event.id = candidate_alert.audit_event_id AND event.identity_issuer = $3
           WHERE ${RECOVERY_READY} AND candidate_alert.attempt_count < $2
             AND ((candidate_alert.status = 'pending' AND candidate_alert.next_attempt_at <= clock_timestamp())
               OR (candidate_alert.status = 'sending' AND candidate_alert.claim_until <= clock_timestamp()))
           ORDER BY candidate_alert.next_attempt_at, candidate_alert.audit_event_id
           LIMIT 1 FOR UPDATE OF candidate_alert SKIP LOCKED
         )
         UPDATE security_alerts AS alert SET status = 'sending', attempt_count = attempt_count + 1,
           claim_id = $1, claim_until = clock_timestamp() + ${LEASE}
         FROM candidate WHERE alert.audit_event_id = candidate.audit_event_id
         RETURNING alert.audit_event_id, alert.rule, alert.attempt_count`,
        [claimId, ALERT_ATTEMPT_LIMIT, this.issuer],
      );
      return result.rows[0];
    });
  }
}
