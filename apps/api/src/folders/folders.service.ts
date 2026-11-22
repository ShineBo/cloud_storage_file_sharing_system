import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database.service";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

type FolderRow = {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: Date;
};

type FolderInput = { name?: string; parentId?: string | null };

@Injectable()
export class FoldersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(ownerId: string) {
    const result = await this.database.query<FolderRow>(
      `SELECT id, name, parent_id, created_at
       FROM folders WHERE owner_id = $1 ORDER BY name, id`,
      [ownerId],
    );
    return result.rows.map(toFolder);
  }

  async create(ownerId: string, input: unknown, eventId?: string) {
    const { name, parentId = null } = readFolderInput(input);
    if (name === undefined) {
      throw new BadRequestException("Enter a folder name.");
    }

    return this.mutate(ownerId, "folder.create", eventId, async (client) => {
      if (parentId !== null) await this.findOwnedFolder(client, ownerId, parentId);
      const result = await client.query<FolderRow>(
        `INSERT INTO folders (id, owner_id, parent_id, name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, parent_id, created_at`,
        [randomUUID(), ownerId, parentId, name],
      );
      return result.rows[0];
    });
  }

  async update(ownerId: string, id: string, input: unknown, eventId?: string) {
    const folderId = readFolderId(id);
    const { name, parentId } = readFolderInput(input);
    if (name === undefined && parentId === undefined) {
      throw new BadRequestException("Enter a name or select a destination folder.");
    }

    return this.mutate(ownerId, "folder.update", eventId, async (client) => {
      const folder = await this.findOwnedFolder(client, ownerId, folderId);
      if (parentId !== undefined && parentId !== null && parentId !== folder.parent_id) {
        await this.findOwnedFolder(client, ownerId, parentId);
        await this.checkMove(client, ownerId, folderId, parentId);
      }

      const result = await client.query<FolderRow>(
        `UPDATE folders SET name = $3, parent_id = $4
         WHERE owner_id = $1 AND id = $2
         RETURNING id, name, parent_id, created_at`,
        [
          ownerId,
          folderId,
          name ?? folder.name,
          parentId === undefined ? folder.parent_id : parentId,
        ],
      );
      return result.rows[0];
    });
  }

  private async mutate(
    ownerId: string,
    action: "folder.create" | "folder.update",
    eventId: string | undefined,
    change: (client: PoolClient) => Promise<FolderRow>,
  ) {
    try {
      return await this.database.transaction(async (client) => {
        // Serialize an owner's moves so a reciprocal move cannot invalidate the cycle check.
        const owner = await client.query(
          "SELECT id FROM employees WHERE id = $1 AND active FOR UPDATE",
          [ownerId],
        );
        if (owner.rowCount === 0) throw new UnauthorizedException();
        const folder = await change(client);
        await this.audit.record({
          eventId,
          action,
          actorId: ownerId,
          itemType: "folder",
          itemId: folder.id,
          outcome: "success",
          status: action === "folder.create" ? 201 : 200,
        }, client);
        return toFolder(folder);
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === "folders_sibling_name_unique"
      ) {
        throw new ConflictException("A folder with that name already exists here.");
      }
      throw error;
    }
  }

  private async findOwnedFolder(client: PoolClient, ownerId: string, id: string) {
    const result = await client.query<FolderRow>(
      `SELECT id, name, parent_id, created_at
       FROM folders WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    const folder = result.rows[0];
    if (!folder) throw new NotFoundException("Folder not found.");
    return folder;
  }

  private async checkMove(
    client: PoolClient,
    ownerId: string,
    folderId: string,
    parentId: string,
  ) {
    const result = await client.query(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_id FROM folders WHERE owner_id = $1 AND id = $2
         UNION
         SELECT folder.id, folder.parent_id
         FROM folders AS folder
         JOIN ancestors AS child ON folder.id = child.parent_id
         WHERE folder.owner_id = $1
       )
       SELECT id FROM ancestors WHERE id = $3`,
      [ownerId, parentId, folderId],
    );
    if (result.rowCount) {
      throw new BadRequestException("A folder cannot be moved into itself or one of its subfolders.");
    }
  }
}

function readFolderInput(input: unknown): FolderInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestException("Send a folder name or parent folder identifier.");
  }
  if (Object.keys(input).some((key) => key !== "name" && key !== "parentId")) {
    throw new BadRequestException("Use only name and parentId for a folder.");
  }

  const { name, parentId } = input as Record<string, unknown>;
  return {
    name: name === undefined ? undefined : readFolderName(name),
    parentId: parentId == null ? parentId : readFolderId(parentId),
  };
}

function readFolderName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(name) ||
    Buffer.byteLength(name) > 255
  ) {
    throw new BadRequestException("Use a folder name of up to 255 bytes without path separators or control characters.");
  }
  return name;
}

function readFolderId(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new BadRequestException("Use a valid folder identifier.");
  }
  return value.toLowerCase();
}

function toFolder(row: FolderRow) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdAt: row.created_at.toISOString(),
  };
}
