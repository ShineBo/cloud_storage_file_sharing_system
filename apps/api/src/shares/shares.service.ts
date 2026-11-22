import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database.service";
import type { StoredBlob } from "../files/files.service";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DEFAULT_EXPIRY_DAYS = 30;

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
};
type OwnedShareRow = ShareRow & { recipient_name: string };
type RecipientShareRow = ShareRow & { owner_name: string; expired: boolean };
type FolderRow = { id: string; name: string; parent_id: string | null };
type FileRow = { id: string; folder_id: string | null } & StoredBlob;
type FileDetails = Pick<FileRow, "id" | "original_name" | "size_bytes" | "mime_type">;

const OWNED_SHARE_SQL = `
  SELECT share.*, COALESCE(employee.display_name, team.name) AS recipient_name
  FROM shares AS share
  LEFT JOIN employees AS employee ON employee.id = share.recipient_employee_id
  LEFT JOIN internal_groups AS team ON team.id = share.recipient_group_id
`;

@Injectable()
export class SharesService {
  constructor(private readonly database: DatabaseService) {}

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

  async create(ownerId: string, body: unknown) {
    const input = readShareInput(body);
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
        return toOwnedShare(existing);
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

      const saved = (await client.query<ShareRow>(
        `INSERT INTO shares (
           id, owner_id, issuer, request_id, file_id, folder_id, recipient_employee_id, recipient_group_id,
           permission, allow_download, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + $11::int * interval '1 day')
         RETURNING *`,
        [
          randomUUID(), ownerId, owner.issuer, input.requestId, fileId, folderId, employeeId,
          groupId, input.permission, input.allowDownload, DEFAULT_EXPIRY_DAYS,
        ],
      )).rows[0];
      return toOwnedShare({ ...saved, recipient_name: recipient.name });
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
      return result.rows.map(toOwnedShare);
    });
  }

  async revoke(ownerId: string, id: string) {
    if (!UUID.test(id)) throw shareUnavailable();
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE shares AS share SET revoked_at = COALESCE(share.revoked_at, clock_timestamp())
         FROM employees AS sender
         WHERE share.id = $1 AND share.owner_id = $2 AND sender.id = share.owner_id AND sender.active`,
        [id, ownerId],
      );
      if (!result.rowCount) throw shareUnavailable();
      const revoked = (await client.query<OwnedShareRow>(
        `${OWNED_SHARE_SQL} WHERE share.id = $1 AND share.owner_id = $2`,
        [id, ownerId],
      )).rows[0];
      return toOwnedShare(revoked);
    });
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
        "SELECT id, name, parent_id FROM folders WHERE owner_id = $1 AND parent_id = $2 ORDER BY name, id",
        [share.owner_id, currentId],
      );
      const files = await client.query<FileDetails>(
        `SELECT id, original_name, size_bytes, mime_type FROM files
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

  async authorizeFile(recipientId: string, id: string, fileId: string, action: Action) {
    if (!UUID.test(fileId)) throw shareUnavailable();
    return this.readSnapshot(async (client) => {
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
    });
  }

  private readSnapshot<T>(work: (client: PoolClient) => Promise<T>) {
    return this.database.transaction(async (client) => {
      // A permission decision and its item metadata must come from the same hierarchy and link state.
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return work(client);
    });
  }

  private async requireOwnedItem(client: PoolClient, ownerId: string, { itemType, itemId }: ItemReference) {
    const table = itemType === "file" ? "files" : "folders";
    const found = await client.query(
      `SELECT item.id FROM ${table} AS item JOIN employees AS sender ON sender.id = item.owner_id
       WHERE item.owner_id = $1 AND item.id = $2 AND sender.active`,
      [ownerId, itemId],
    );
    if (!found.rowCount) throw new NotFoundException("The item is unavailable in your workspace.");
  }

  private async requireRecipientShare(client: PoolClient, recipientId: string, id: string) {
    if (!UUID.test(id)) throw shareUnavailable();
    const share = (await client.query<RecipientShareRow>(
      `SELECT share.*, sender.display_name AS owner_name, share.expires_at <= now() AS expired
       FROM shares AS share
       JOIN employees AS sender ON sender.id = share.owner_id AND sender.active
       JOIN employees AS recipient
         ON recipient.id = $2 AND recipient.issuer = share.issuer AND recipient.active
       WHERE share.id = $1 AND (
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
      `SELECT id, folder_id, original_name, size_bytes, mime_type, sha256, blob_key
       FROM files WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    )).rows[0];
    if (!file) throw shareUnavailable();
    return file;
  }

  private async requireFolderPath(client: PoolClient, ownerId: string, rootId: string, leafId: string) {
    const result = await client.query<FolderRow>(
      `WITH RECURSIVE ancestors AS (
         SELECT id, name, parent_id FROM folders WHERE owner_id = $1 AND id = $2
         UNION
         SELECT folder.id, folder.name, folder.parent_id
         FROM folders AS folder JOIN ancestors AS child ON child.parent_id = folder.id
         WHERE folder.owner_id = $1 AND child.id <> $3
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

function toOwnedShare(share: OwnedShareRow) {
  return {
    id: share.id,
    link: `/shared/${share.id}`,
    recipientName: share.recipient_name,
    permission: share.permission,
    allowDownload: share.allow_download,
    expiresAt: share.expires_at.toISOString(),
    revokedAt: share.revoked_at?.toISOString() ?? null,
  };
}

export function toSharedFile(file: FileDetails) {
  return {
    id: file.id,
    name: file.original_name,
    type: "file" as const,
    size: Number(file.size_bytes),
    mimeType: file.mime_type,
  };
}

function toSharedFolder(folder: FolderRow) {
  return { id: folder.id, name: folder.name, type: "folder" as const };
}
