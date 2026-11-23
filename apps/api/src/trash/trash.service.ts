import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { auditItemId, AuditService, type AuditAttempt } from "../audit/audit.service";
import { DatabaseService } from "../database.service";
import { PolicyService } from "../policies/policy.service";

type ItemType = "file" | "folder";
type TrashRow = {
  id: string;
  item_type: ItemType;
  item_id: string;
  name: string;
  deleted_at: Date;
  restore_until: Date;
  can_restore: boolean;
};
type TrashedItem = { name: string; parent_id: string | null; trash_id: string | null };

const TRASH_COLUMNS = "id, item_type, item_id, name, deleted_at, restore_until, restore_until > clock_timestamp() AS can_restore";

@Injectable()
export class TrashService {
  constructor(
    private readonly database: DatabaseService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  async list(ownerId: string) {
    const found = await this.database.query<TrashRow>(
      `SELECT ${TRASH_COLUMNS} FROM trash_entries WHERE owner_id = $1 ORDER BY deleted_at DESC, id`,
      [ownerId],
    );
    return found.rows.map(toTrashItem);
  }

  async remove(ownerId: string, input: unknown, event: AuditAttempt) {
    const { itemType, itemId } = readItem(input);
    event.itemType = itemType;
    event.itemId = itemId;
    return this.database.transaction(async (client) => {
      await lockOwner(client, ownerId);
      const replay = await client.query<TrashRow>(
        `SELECT ${TRASH_COLUMNS} FROM trash_entries WHERE owner_id = $1 AND item_type = $2 AND item_id = $3`,
        [ownerId, itemType, itemId],
      );
      if (replay.rows[0]) return toTrashItem(replay.rows[0]);

      const item = await this.findItem(client, ownerId, itemType, itemId);
      if (!item || item.trash_id !== null) throw new NotFoundException("The item is unavailable in your workspace.");
      const { retentionDays } = await this.policy.read(client, true);
      const entry = (await client.query<TrashRow>(
        `WITH moment AS (SELECT clock_timestamp() AS deleted_at)
         INSERT INTO trash_entries (id, owner_id, item_type, item_id, name, deleted_at, restore_until)
         SELECT $1, $2, $3, $4, $5, deleted_at, deleted_at + $6::integer * interval '24 hours' FROM moment
         RETURNING ${TRASH_COLUMNS}`,
        [randomUUID(), ownerId, itemType, itemId, item.name, retentionDays],
      )).rows[0];
      if (itemType === "file") {
        await client.query("UPDATE files SET trash_id = $3 WHERE owner_id = $1 AND id = $2", [ownerId, itemId, entry.id]);
      } else {
        await client.query(
          `WITH RECURSIVE descendants AS (
             SELECT id FROM folders WHERE owner_id = $1 AND id = $2 AND trash_id IS NULL
             UNION
             SELECT folder.id FROM folders AS folder JOIN descendants AS parent ON folder.parent_id = parent.id
             WHERE folder.owner_id = $1 AND folder.trash_id IS NULL
           ), tagged AS (
             UPDATE folders SET trash_id = $3 WHERE owner_id = $1 AND id IN (SELECT id FROM descendants)
             RETURNING id
           )
           UPDATE files SET trash_id = $3 WHERE owner_id = $1 AND trash_id IS NULL
             AND folder_id IN (SELECT id FROM tagged)`,
          [ownerId, itemId, entry.id],
        );
      }
      await this.audit.record({
        ...event, outcome: "success", status: 201, detail: { restoreUntil: entry.restore_until.toISOString() },
      }, client);
      return toTrashItem(entry);
    });
  }

  async restore(ownerId: string, value: string, event: AuditAttempt) {
    const id = auditItemId(value);
    if (!id) throw trashNotFound();
    try {
      return await this.database.transaction(async (client) => {
        await lockOwner(client, ownerId);
        const entry = (await client.query<TrashRow>(
          `SELECT ${TRASH_COLUMNS} FROM trash_entries WHERE owner_id = $1 AND id = $2`,
          [ownerId, id],
        )).rows[0];
        if (!entry) throw trashNotFound();
        event.itemType = entry.item_type;
        event.itemId = entry.item_id;
        if (!entry.can_restore) {
          throw new GoneException("The recovery window has ended. Contact your administrator about recovery options.");
        }
        const item = await this.findItem(client, ownerId, entry.item_type, entry.item_id);
        if (!item || item.trash_id !== id) throw trashNotFound();
        if (item.parent_id) {
          const parent = await this.findItem(client, ownerId, "folder", item.parent_id);
          if (!parent || parent.trash_id !== null) {
            throw new ConflictException("Restore the original parent folder before restoring this item.");
          }
        }
        if (entry.item_type === "folder") {
          await client.query("UPDATE folders SET trash_id = NULL WHERE owner_id = $1 AND trash_id = $2", [ownerId, id]);
        }
        await client.query("UPDATE files SET trash_id = NULL WHERE owner_id = $1 AND trash_id = $2", [ownerId, id]);
        await client.query("DELETE FROM trash_entries WHERE owner_id = $1 AND id = $2", [ownerId, id]);
        await this.audit.record({ ...event, outcome: "success", status: 200 }, client);
        return { ...toTrashItem(entry), canRestore: false };
      });
    } catch (error) {
      if (
        error instanceof Error && "code" in error && error.code === "23505" &&
        "constraint" in error && error.constraint === "folders_sibling_name_unique"
      ) {
        throw new ConflictException("A folder with that name exists in the original location. Rename it before restoring.");
      }
      throw error;
    }
  }

  private async findItem(client: PoolClient, ownerId: string, itemType: ItemType, id: string) {
    const source = itemType === "file"
      ? "SELECT original_name AS name, folder_id AS parent_id, trash_id FROM files"
      : "SELECT name, parent_id, trash_id FROM folders";
    const found = await client.query<TrashedItem>(`${source} WHERE owner_id = $1 AND id = $2`, [ownerId, id]);
    return found.rows[0];
  }
}

async function lockOwner(client: PoolClient, ownerId: string) {
  // Serialize subtree changes with workspace folder moves and file publication.
  const result = await client.query("SELECT id FROM employees WHERE id = $1 AND active FOR UPDATE", [ownerId]);
  if (!result.rowCount) throw new UnauthorizedException();
}

function readItem(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestException("Choose a file or folder to move to Trash.");
  }
  const { itemType, itemId: reference } = input as Record<string, unknown>;
  const itemId = auditItemId(reference);
  if ((itemType !== "file" && itemType !== "folder") || !itemId) {
    throw new BadRequestException("Choose a file or folder to move to Trash.");
  }
  return { itemType, itemId } as const;
}

function trashNotFound() {
  return new NotFoundException("This item is unavailable in Trash. Refresh to check your workspace.");
}

function toTrashItem(row: TrashRow) {
  return {
    id: row.id,
    itemType: row.item_type,
    itemId: row.item_id,
    name: row.name,
    deletedAt: row.deleted_at.toISOString(),
    restoreUntil: row.restore_until.toISOString(),
    canRestore: row.can_restore,
  };
}
