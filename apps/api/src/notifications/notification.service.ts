import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { DatabaseService } from "../database.service";
import { LIVE_SHARE_TARGET } from "../shares/live-share-target";

export type ShareDelivery = {
  status: "not_sent" | "pending" | "sent" | "failed" | "partial";
  sent: number;
  total: number;
};

type Queryable = Pick<DatabaseService, "query">;

export const ELIGIBLE_RECIPIENTS = `
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
export class NotificationService {
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
}
