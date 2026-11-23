import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AuditService, type AuditAttempt } from "../audit/audit.service";
import { DatabaseService } from "../database.service";
import type { StoredBlob } from "../files/files.service";
import { PolicyService } from "../policies/policy.service";
import { LIVE_SHARE_TARGET } from "./live-share-target";
import { NotificationService, type ShareDelivery } from "../notifications/notification.service";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Each share is one link, addressed only to the stored employee or group.
type ItemType = "file" | "folder";
type Permission = "view" | "edit";
type Action = Permission | "download";
type ItemReference = { itemType: ItemType; itemId: string };
type ShareInput = ItemReference & {
  recipientType: "employee" | "group";
  recipientId: string;
  permission: Permission;
  allowDownload: boolean;
  requestId: string;
};
type ShareRow = {
  id: string;
  owner_id: string;
  file_id: string | null;
  folder_id: string | null;
  recipient_employee_id: string | null;
  recipient_group_id: string | null;
  permission: Permission;
  allow_download: boolean;
  expires_at: Date;
  revoked_at: Date | null;
  last_access_failure_at: Date | null;
};
type OwnedShareRow = ShareRow & { recipient_name: string };
type RecipientShareRow = ShareRow & { owner_name: string; expired: boolean };
type FolderRow = { id: string; name: string; parent_id: string | null };
type FileDetails = StoredBlob & { id: string; revision: number; author_name: string; revised_at: Date };
type FileRow = FileDetails & { owner_id: string; folder_id: string | null };
const SHARED_FILE_COLUMNS = "id, original_name, size_bytes, mime_type, revision, author_name, revised_at";

const OWNED_SHARE_SQL = `
  SELECT share.*, COALESCE(employee.display_name, team.name) AS recipient_name
  FROM shares AS share
  LEFT JOIN employees AS employee ON employee.id = share.recipient_employee_id
  LEFT JOIN internal_groups AS team ON team.id = share.recipient_group_id
`;

@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly policies: PolicyService,
  ) {}

  async recipients(ownerId: string) {
    const [employees, groups] = await Promise.all([
      this.database.query<{ id: string; username: string; displayName: string }>(
        `SELECT candidate.id, candidate.username, candidate.display_name AS "displayName"
         FROM employees AS sender
         JOIN employees AS candidate ON candidate.issuer = sender.issuer AND candidate.active
         WHERE sender.id = $1 AND sender.active
         ORDER BY candidate.display_name, candidate.username, candidate.id`,
        [ownerId],
      ),
      this.database.query<{ id: string; name: string }>(
        `SELECT team.id, team.name
         FROM employees AS sender
         JOIN internal_groups AS team ON team.issuer = sender.issuer AND team.approved
         WHERE sender.id = $1 AND sender.active
         ORDER BY team.name, team.id`,
        [ownerId],
      ),
    ]);
    return { employees: employees.rows, groups: groups.rows };
  }

  async create(ownerId: string, body: unknown, event: AuditAttempt) {
    const input = readShareInput(body);
    event.itemType = input.itemType;
    event.itemId = input.itemId;
    const fileId = input.itemType === "file" ? input.itemId : null;
    const folderId = input.itemType === "folder" ? input.itemId : null;
    const employeeId = input.recipientType === "employee" ? input.recipientId : null;
    const groupId = input.recipientType === "group" ? input.recipientId : null;

    return this.database.transaction(async (client) => {
      // Serialize creations by sender so concurrent retries get the same committed link.
      const owner = (await client.query<{ issuer: string }>(
        "SELECT issuer FROM employees WHERE id = $1 AND active FOR NO KEY UPDATE",
        [ownerId],
      )).rows[0];
      if (!owner) throw new UnauthorizedException();

      const existing = (await client.query<OwnedShareRow>(
        `${OWNED_SHARE_SQL} WHERE share.owner_id = $1 AND share.request_id = $2`,
        [ownerId, input.requestId],
      )).rows[0];
      if (existing) {
        if (
          existing.file_id !== fileId || existing.folder_id !== folderId ||
          existing.recipient_employee_id !== employeeId || existing.recipient_group_id !== groupId ||
          existing.permission !== input.permission || existing.allow_download !== input.allowDownload
        ) {
          throw new ConflictException("This share request was already used with different details.");
        }
        const [share] = await this.withDelivery(client, [existing]);
        return share;
      }

      await this.requireOwnedItem(client, ownerId, input);
      const recipient = (await client.query<{ name: string }>(
        `SELECT display_name AS name FROM employees WHERE issuer = $1 AND id = $2 AND active
         UNION ALL
         SELECT name FROM internal_groups WHERE issuer = $1 AND id = $3 AND approved`,
        [owner.issuer, employeeId, groupId],
      )).rows[0];
      if (!recipient) {
        throw new BadRequestException("Choose an active internal employee or an approved group.");
      }

      const { linkExpiryDays } = await this.policies.read(client, true);
      const saved = (await client.query<ShareRow>(
        `INSERT INTO shares (
           id, owner_id, issuer, request_id, file_id, folder_id, recipient_employee_id, recipient_group_id,
           permission, allow_download, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp() + $11::int * interval '1 day')
         RETURNING *`,
        [
          randomUUID(), ownerId, owner.issuer, input.requestId, fileId, folderId, employeeId,
          groupId, input.permission, input.allowDownload, linkExpiryDays,
        ],
      )).rows[0];
      await this.notifications.queueShare(client, saved.id);
      await this.audit.record({ ...event, outcome: "success", status: 201 }, client);
      const [share] = await this.withDelivery(client, [{ ...saved, recipient_name: recipient.name }]);
      return share;
    });
  }

  async list(ownerId: string, itemType: unknown, itemId: unknown) {
    const item = readItemReference(itemType, itemId);
    return this.readSnapshot(async (client) => {
      await this.requireOwnedItem(client, ownerId, item);
      const column = item.itemType === "file" ? "file_id" : "folder_id";
      const result = await client.query<OwnedShareRow>(
        `${OWNED_SHARE_SQL} WHERE share.owner_id = $1 AND share.${column} = $2
         ORDER BY share.created_at DESC, share.id`,
        [ownerId, item.itemId],
      );
      return this.withDelivery(client, result.rows);
    });
  }

  async revoke(ownerId: string, id: string, event: AuditAttempt) {
    if (!UUID.test(id)) throw shareUnavailable();
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE shares AS share SET revoked_at = clock_timestamp()
         FROM employees AS sender
         WHERE share.id = $1 AND share.owner_id = $2 AND sender.id = share.owner_id AND sender.active
           AND share.revoked_at IS NULL`,
        [id, ownerId],
      );
      const revoked = (await client.query<OwnedShareRow>(
        `${OWNED_SHARE_SQL} JOIN employees AS sender ON sender.id = share.owner_id AND sender.active
         WHERE share.id = $1 AND share.owner_id = $2`,
        [id, ownerId],
      )).rows[0];
      if (!revoked) throw shareUnavailable();
      if (result.rowCount) {
        event.itemType = revoked.file_id ? "file" : "folder";
        event.itemId = revoked.file_id ?? revoked.folder_id;
        await this.audit.record({ ...event, outcome: "success", status: 200 }, client);
      }
      const [share] = await this.withDelivery(client, [revoked]);
      return share;
    });
  }

  async retryDelivery(ownerId: string, id: string) {
    if (!UUID.test(id)) throw shareUnavailable();
    return this.database.transaction(async (client) => {
      const current = (await client.query<{ revoked_at: Date | null; expired: boolean }>(
        `SELECT share.revoked_at, share.expires_at <= clock_timestamp() AS expired
         FROM shares AS share
         JOIN employees AS sender ON sender.id = share.owner_id AND sender.active
         WHERE share.id = $1 AND share.owner_id = $2 AND ${LIVE_SHARE_TARGET}
         FOR NO KEY UPDATE OF share`,
        [id, ownerId],
      )).rows[0];
      if (!current) throw shareUnavailable();
      if (current.revoked_at || current.expired) {
        throw new GoneException("This link is no longer active. Create a new share before sending an email.");
      }

      await this.notifications.retryShare(client, id.toLowerCase());
      const updated = (await client.query<OwnedShareRow>(
        `${OWNED_SHARE_SQL} WHERE share.id = $1 AND share.owner_id = $2`,
        [id, ownerId],
      )).rows[0];
      const [share] = await this.withDelivery(client, [updated]);
      return share;
    });
  }

  async recordAccessFailure(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    try {
      const result = await this.database.query(
        `UPDATE shares SET last_access_failure_at = clock_timestamp()
         WHERE id = $1 AND issuer = $2`,
        [id, process.env.OIDC_ISSUER?.trim()],
      );
      return Boolean(result.rowCount);
    } catch {
      this.logger.warn("Could not save share access feedback.");
      return false;
    }
  }

  async browse(recipientId: string, id: string, folderId: unknown) {
    if (folderId !== undefined && (typeof folderId !== "string" || !UUID.test(folderId))) {
      throw shareUnavailable();
    }
    return this.readSnapshot(async (client) => {
      const share = await this.requireRecipientShare(client, recipientId, id);
      const { owner_name, permission, allow_download, expires_at } = share;
      const details = {
        ownerName: owner_name, permission, allowDownload: allow_download, expiresAt: expires_at.toISOString(),
      };

      if (share.file_id) {
        if (folderId !== undefined) throw shareUnavailable();
        const file = await this.findFile(client, share.owner_id, share.file_id);
        return { ...details, item: toSharedFile(file), entries: [], ancestors: [] };
      }

      const rootId = share.folder_id!;
      const currentId = typeof folderId === "string" ? folderId.toLowerCase() : rootId;
      const path = await this.requireFolderPath(client, share.owner_id, rootId, currentId);
      const current = path[path.length - 1];
      const folders = await client.query<FolderRow>(
        "SELECT id, name, parent_id FROM folders WHERE owner_id = $1 AND parent_id = $2 AND trash_id IS NULL ORDER BY name, id",
        [share.owner_id, currentId],
      );
      const files = await client.query<FileDetails>(
        `SELECT ${SHARED_FILE_COLUMNS} FROM current_files
         WHERE owner_id = $1 AND folder_id = $2 ORDER BY original_name, id`,
        [share.owner_id, currentId],
      );
      return {
        ...details,
        item: toSharedFolder(current),
        entries: [...folders.rows.map(toSharedFolder), ...files.rows.map(toSharedFile)],
        ancestors: path.slice(0, -1).map(({ id, name }) => ({ id, name })),
      };
    });
  }

  async authorizeFile(recipientId: string, id: string, fileId: string, action: Action, transaction?: PoolClient) {
    if (!UUID.test(id) || !UUID.test(fileId)) throw shareUnavailable();
    const check = async (client: PoolClient) => {
      const share = await this.requireRecipientShare(client, recipientId, id);
      if (share.file_id && share.file_id !== fileId.toLowerCase()) throw shareUnavailable();
      const file = await this.findFile(client, share.owner_id, fileId);
      if (share.folder_id) {
        if (!file.folder_id) throw shareUnavailable();
        await this.requireFolderPath(client, share.owner_id, share.folder_id, file.folder_id);
      }
      if (action === "download" && !share.allow_download) {
        throw new ForbiddenException("This share does not allow downloads.");
      }
      if (action === "edit" && share.permission !== "edit") {
        throw new ForbiddenException("This share does not allow editing.");
      }
      return file;
    };
    if (!transaction) return this.readSnapshot(check);

    // The write transaction already locks the file owner, editor, and current file.
    // Hold the link and applicable group membership through publication too.
    const link = await transaction.query<{ recipient_group_id: string | null }>(
      "SELECT recipient_group_id FROM shares WHERE id = $1 FOR SHARE",
      [id],
    );
    const groupId = link.rows[0]?.recipient_group_id;
    if (groupId) {
      const membership = await transaction.query(
        `SELECT 1 FROM internal_group_members AS member
         JOIN internal_groups AS team ON team.id = member.group_id AND team.approved
         WHERE member.group_id = $1 AND member.employee_id = $2
         FOR SHARE OF member, team`,
        [groupId, recipientId],
      );
      if (!membership.rowCount) throw shareUnavailable();
    }
    return check(transaction);
  }

  private readSnapshot<T>(work: (client: PoolClient) => Promise<T>) {
    return this.database.transaction(async (client) => {
      // A permission decision and its item metadata must come from the same hierarchy and link state.
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return work(client);
    });
  }

  private async withDelivery(client: PoolClient, rows: OwnedShareRow[]) {
    const delivery = await this.notifications.shareStatus(client, rows.map(({ id }) => id));
    return rows.map((row) => toOwnedShare(row, delivery.get(row.id)));
  }

  private async requireOwnedItem(client: PoolClient, ownerId: string, { itemType, itemId }: ItemReference) {
    const table = itemType === "file" ? "files" : "folders";
    const found = await client.query(
      `SELECT item.id FROM ${table} AS item JOIN employees AS sender ON sender.id = item.owner_id
       WHERE item.owner_id = $1 AND item.id = $2 AND item.trash_id IS NULL AND sender.active`,
      [ownerId, itemId],
    );
    if (!found.rowCount) throw new NotFoundException("The item is unavailable in your workspace.");
  }

  private async requireRecipientShare(client: PoolClient, recipientId: string, id: string) {
    if (!UUID.test(id)) throw shareUnavailable();
    const share = (await client.query<RecipientShareRow>(
      `SELECT share.*, sender.display_name AS owner_name, share.expires_at <= clock_timestamp() AS expired
       FROM shares AS share
       JOIN employees AS sender ON sender.id = share.owner_id AND sender.active
       JOIN employees AS recipient
         ON recipient.id = $2 AND recipient.issuer = share.issuer AND recipient.active
       WHERE share.id = $1 AND ${LIVE_SHARE_TARGET} AND (
         share.recipient_employee_id = recipient.id OR EXISTS (
           SELECT 1 FROM internal_group_members AS member
           JOIN internal_groups AS team ON team.id = member.group_id AND team.approved
           WHERE team.id = share.recipient_group_id AND member.employee_id = recipient.id
         )
       )`,
      [id, recipientId],
    )).rows[0];
    if (!share) throw shareUnavailable();
    if (share.revoked_at) throw new GoneException("The sender revoked this link. Ask them for a new link.");
    if (share.expired) throw new GoneException("This link has expired. Ask the sender for a new link.");
    return share;
  }

  private async findFile(client: PoolClient, ownerId: string, id: string) {
    const file = (await client.query<FileRow>(
      `SELECT ${SHARED_FILE_COLUMNS}, owner_id, folder_id, sha256, blob_key
       FROM current_files WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    )).rows[0];
    if (!file) throw shareUnavailable();
    return file;
  }

  private async requireFolderPath(client: PoolClient, ownerId: string, rootId: string, leafId: string) {
    const result = await client.query<FolderRow>(
      `WITH RECURSIVE ancestors AS (
         SELECT id, name, parent_id FROM folders WHERE owner_id = $1 AND id = $2 AND trash_id IS NULL
         UNION
         SELECT folder.id, folder.name, folder.parent_id
         FROM folders AS folder JOIN ancestors AS child ON child.parent_id = folder.id
         WHERE folder.owner_id = $1 AND folder.trash_id IS NULL AND child.id <> $3
       ) SELECT id, name, parent_id FROM ancestors`,
      [ownerId, leafId, rootId],
    );
    const byId = new Map(result.rows.map((folder) => [folder.id, folder]));
    if (!byId.has(rootId)) throw shareUnavailable();

    const path: FolderRow[] = [];
    let folder = byId.get(leafId);
    while (folder) {
      path.push(folder);
      if (folder.id === rootId) return path.reverse();
      folder = folder.parent_id ? byId.get(folder.parent_id) : undefined;
    }
    throw shareUnavailable();
  }
}

function readShareInput(body: unknown): ShareInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("Choose an item, recipient, and permission to create a share.");
  }
  const input = body as Record<string, unknown>;
  const fields = ["itemType", "itemId", "recipientType", "recipientId", "permission", "allowDownload", "requestId"];
  if (Object.keys(input).some((key) => !fields.includes(key))) {
    throw new BadRequestException("Use the available item, recipient, and permission options.");
  }
  const item = readItemReference(input.itemType, input.itemId);
  if (input.recipientType !== "employee" && input.recipientType !== "group") {
    throw new BadRequestException("Choose an active internal employee or an approved group.");
  }
  if ((input.permission !== "view" && input.permission !== "edit") || typeof input.allowDownload !== "boolean") {
    throw new BadRequestException("Choose View or Edit and indicate whether downloads are allowed.");
  }
  return {
    ...item,
    recipientType: input.recipientType,
    recipientId: readUuid(input.recipientId, "Choose an active internal employee or an approved group."),
    permission: input.permission,
    allowDownload: input.allowDownload,
    requestId: input.requestId === undefined ? randomUUID() : readUuid(input.requestId, "Use a valid share request identifier."),
  };
}

function readItemReference(itemType: unknown, itemId: unknown): ItemReference {
  const message = "Choose a file or folder in your workspace.";
  if (itemType !== "file" && itemType !== "folder") throw new BadRequestException(message);
  return { itemType, itemId: readUuid(itemId, message) };
}

function readUuid(value: unknown, message: string) {
  if (typeof value !== "string" || !UUID.test(value)) throw new BadRequestException(message);
  return value.toLowerCase();
}

function shareUnavailable() {
  return new NotFoundException("This item or share link is unavailable for your account.");
}

function toOwnedShare(
  share: OwnedShareRow,
  delivery: ShareDelivery = { status: "not_sent", sent: 0, total: 0 },
) {
  return {
    id: share.id,
    link: `/shared/${share.id}`,
    recipientName: share.recipient_name,
    permission: share.permission,
    allowDownload: share.allow_download,
    expiresAt: share.expires_at.toISOString(),
    revokedAt: share.revoked_at?.toISOString() ?? null,
    delivery,
    lastAccessFailureAt: share.last_access_failure_at?.toISOString() ?? null,
  };
}

export function toSharedFile(file: Omit<FileDetails, "sha256" | "blob_key">) {
  return {
    id: file.id,
    name: file.original_name,
    type: "file" as const,
    size: Number(file.size_bytes),
    mimeType: file.mime_type,
    revision: file.revision,
    authorName: file.author_name,
    revisedAt: file.revised_at.toISOString(),
  };
}

function toSharedFolder(folder: FolderRow) {
  return { id: folder.id, name: folder.name, type: "folder" as const };
}
