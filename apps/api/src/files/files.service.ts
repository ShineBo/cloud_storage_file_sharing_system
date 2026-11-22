import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  RequestTimeoutException,
  ServiceUnavailableException,
  StreamableFile,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import type { Multipart, MultipartFile } from "@fastify/multipart";
import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database.service";
import { expectedFileType, verifyFileType } from "./file-media";
import { officePreview } from "./office-preview";

const DEFAULT_MAX_FILE_BYTES = 2_000_000_000;
const DEFAULT_QUOTA_BYTES = 20_000_000_000;
export const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FILE_COLUMNS = "id, original_name, folder_id, size_bytes, sha256, mime_type, created_at";

type FileRow = {
  id: string;
  original_name: string;
  folder_id: string | null;
  size_bytes: string;
  sha256: string;
  mime_type: string;
  created_at: Date;
};

export type StoredBlob = Pick<FileRow, "original_name" | "size_bytes" | "sha256" | "mime_type"> & {
  blob_key: string;
};

type UploadContext = {
  folderId: string | null;
  declaredSize: number | undefined;
  expiresAt: Date;
  signal: AbortSignal;
  parts: (limit: number) => AsyncIterable<Multipart>;
};

type FileChanges = { name?: string; folderId?: string | null };
type Reservation = { bytes: number; expiredIds: string[] };
type StagedFile = { name: string; size: number; sha256: string; mimeType: string };
type Queryable = Pick<DatabaseService, "query">;

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly maxFileBytes = readLimit("FILE_MAX_BYTES", DEFAULT_MAX_FILE_BYTES);
  private readonly quotaBytes = readLimit("FILE_QUOTA_BYTES", DEFAULT_QUOTA_BYTES);

  constructor(private readonly database: DatabaseService) {}

  async list(ownerId: string, folderId: string | null) {
    await requireOwnedFolder(this.database, ownerId, folderId);
    const result = await this.database.query<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM files WHERE owner_id = $1
         AND folder_id IS NOT DISTINCT FROM $2::uuid ORDER BY created_at DESC, id DESC`,
      [ownerId, folderId],
    );
    return result.rows.map(toPublicFile);
  }

  async policy(ownerId: string) {
    const usage = await this.readUsage(this.database, ownerId);
    return { maxFileBytes: this.maxFileBytes, quotaBytes: this.quotaBytes, ...usage };
  }

  async upload(ownerId: string, context: UploadContext) {
    const { declaredSize, folderId, signal } = context;
    if (declaredSize !== undefined && declaredSize > this.maxFileBytes) {
      throw this.fileTooLarge();
    }
    const storage = this.storagePath();
    await mkdir(storage, { recursive: true, mode: 0o700 });
    const key = randomUUID();
    const stagedPath = join(storage, `${key}.upload`);
    const blobPath = join(storage, key);
    let publishedBlob = false;
    let mayHaveCommitted = false;

    try {
      const reservation = await this.reserve(ownerId, key, context);
      await Promise.all(reservation.expiredIds.map((id) => this.remove(join(storage, `${id}.upload`))));
      signal.throwIfAborted();

      let upload: StagedFile | undefined;
      for await (const part of context.parts(reservation.bytes)) {
        if (part.type !== "file" || part.fieldname !== "file" || upload) {
          if (part.type === "file") part.file.resume();
          throw new BadRequestException("Send a single file in the file field.");
        }
        upload = await this.stage(part, stagedPath, reservation.bytes, declaredSize, signal);
      }
      signal.throwIfAborted();
      if (!upload) {
        throw new BadRequestException("Send a single file in the file field.");
      }

      const completed = upload;
      const row = await this.database.transaction(async (client) => {
        await lockActiveEmployee(client, ownerId);
        await requireOwnedFolder(client, ownerId, folderId);
        const active = await client.query(
          `DELETE FROM file_upload_reservations
           WHERE id = $1 AND owner_id = $2 AND expires_at > clock_timestamp() RETURNING id`,
          [key, ownerId],
        );
        if (!active.rowCount) throw uploadTimedOut();
        signal.throwIfAborted();
        await rename(stagedPath, blobPath);
        publishedBlob = true;
        const inserted = await client.query<FileRow>(
          `INSERT INTO files (id, owner_id, folder_id, original_name, blob_key, size_bytes, sha256, mime_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${FILE_COLUMNS}`,
          [
            randomUUID(), ownerId, folderId, completed.name, key,
            completed.size, completed.sha256, completed.mimeType,
          ],
        );
        signal.throwIfAborted();
        mayHaveCommitted = true;
        return inserted.rows[0];
      });
      return toPublicFile(row);
    } catch (error) {
      if (publishedBlob && !mayHaveCommitted) {
        await this.remove(blobPath);
      } else if (publishedBlob) {
        // A lost COMMIT response can follow a committed insert.
        this.logger.error("Could not confirm the file metadata insert.");
      }
      if (signal.aborted) throw uploadTimedOut();
      throw error;
    } finally {
      await Promise.all([
        this.remove(stagedPath),
        this.releaseReservation(ownerId, key),
      ]);
    }
  }

  async update(ownerId: string, id: string, changes: FileChanges) {
    if (!UUID.test(id)) throw fileNotFound();
    return this.database.transaction(async (client) => {
      const found = await client.query<FileRow>(
        `SELECT ${FILE_COLUMNS} FROM files WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
        [ownerId, id],
      );
      const file = found.rows[0];
      if (!file) throw fileNotFound();

      const name = changes.name ?? file.original_name;
      if (changes.name !== undefined && expectedFileType(name).mimeType !== file.mime_type) {
        throw new UnsupportedMediaTypeException("Keep the extension for this file's original type.");
      }
      const folderId = changes.folderId === undefined ? file.folder_id : changes.folderId;
      await requireOwnedFolder(client, ownerId, folderId);
      const result = await client.query<FileRow>(
        `UPDATE files SET original_name = $3, folder_id = $4 WHERE owner_id = $1 AND id = $2
         RETURNING ${FILE_COLUMNS}`,
        [ownerId, id, name, folderId],
      );
      return toPublicFile(result.rows[0]);
    });
  }

  async download(ownerId: string, id: string) {
    if (!UUID.test(id)) throw fileNotFound();
    const result = await this.database.query<FileRow & { blob_key: string }>(
      `SELECT ${FILE_COLUMNS}, blob_key FROM files WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    const file = result.rows[0];
    if (!file) throw fileNotFound();
    return this.serveAuthorized(file, "download");
  }

  async serveAuthorized(file: StoredBlob, action: "view" | "download") {
    let handle: FileHandle | undefined;
    try {
      const path = join(this.storagePath(), file.blob_key);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const size = Number(file.size_bytes);
      const stat = await handle.stat({ bigint: true });
      if (
        !stat.isFile() ||
        stat.size !== BigInt(size) ||
        await hashStoredFile(handle, size) !== file.sha256
      ) {
        throw new Error("File bytes differ from metadata.");
      }
      const after = await handle.stat({ bigint: true });
      if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) {
        throw new Error("File changed during verification.");
      }

      if (action === "view" && file.mime_type.startsWith("application/vnd.openxmlformats-officedocument.")) {
        try {
          return await officePreview(handle, size, file.mime_type);
        } finally {
          await handle.close();
          handle = undefined;
        }
      }

      const encodedName = encodeURIComponent(file.original_name).replace(
        /['()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      const mode = action === "view" ? "inline" : "attachment";
      return new StreamableFile(handle.createReadStream({ start: 0, end: size - 1 }), {
        disposition: `${mode}; filename="download"; filename*=UTF-8''${encodedName}`,
        type: file.mime_type,
        length: size,
      });
    } catch {
      await handle?.close();
      this.logger.error("Could not verify or serve a stored file.");
      throw new ServiceUnavailableException("The file is temporarily unavailable.");
    }
  }

  private async reserve(ownerId: string, key: string, context: UploadContext): Promise<Reservation> {
    return this.database.transaction(async (client) => {
      await lockActiveEmployee(client, ownerId);
      await requireOwnedFolder(client, ownerId, context.folderId);
      context.signal.throwIfAborted();
      const expired = await client.query<{ id: string }>(
        `DELETE FROM file_upload_reservations WHERE owner_id = $1
           AND expires_at <= clock_timestamp() RETURNING id`,
        [ownerId],
      );
      const { availableBytes } = await this.readUsage(client, ownerId);
      const bytes = context.declaredSize ?? Math.min(this.maxFileBytes, availableBytes);
      if (bytes <= 0 || bytes > availableBytes) {
        throw quotaExceeded();
      }
      await client.query(
        `INSERT INTO file_upload_reservations (id, owner_id, reserved_bytes, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [key, ownerId, bytes, context.expiresAt],
      );
      return { bytes, expiredIds: expired.rows.map(({ id }) => id) };
    });
  }

  private async readUsage(database: Queryable, ownerId: string) {
    const result = await database.query<{ used: string; reserved: string }>(
      `SELECT
         (SELECT COALESCE(SUM(size_bytes), 0)::text FROM files WHERE owner_id = $1) AS used,
         (SELECT COALESCE(SUM(reserved_bytes), 0)::text FROM file_upload_reservations
          WHERE owner_id = $1 AND expires_at > clock_timestamp()) AS reserved`,
      [ownerId],
    );
    const { used, reserved } = result.rows[0];
    const usedBytes = Number(used);
    const availableBytes = Math.max(0, this.quotaBytes - usedBytes - Number(reserved));
    return { usedBytes, availableBytes };
  }

  private async stage(
    part: MultipartFile,
    path: string,
    limit: number,
    declaredSize: number | undefined,
    signal: AbortSignal,
  ): Promise<StagedFile> {
    let name: string;
    let expected: ReturnType<typeof expectedFileType>;
    try {
      name = parseFileName(part.filename);
      expected = expectedFileType(name);
    } catch (error) {
      part.file.resume();
      throw error;
    }

    const hash = createHash("sha256");
    let size = 0;
    const inspect = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size <= limit) {
          hash.update(chunk);
          callback(null, chunk);
        } else {
          callback();
        }
      },
    });

    await pipeline(
      part.file,
      inspect,
      createWriteStream(path, { flags: "wx", mode: 0o600, flush: true }),
      { signal },
    );
    if (part.file.truncated || size > limit) {
      if (limit === this.maxFileBytes) throw this.fileTooLarge();
      if (declaredSize === undefined) throw quotaExceeded();
      throw sizeMismatch();
    }
    if (declaredSize !== undefined && declaredSize !== size) throw sizeMismatch();
    signal.throwIfAborted();
    await verifyFileType(path, expected);
    return { name, size, sha256: hash.digest("hex"), mimeType: expected.mimeType };
  }

  private fileTooLarge() {
    return new PayloadTooLargeException(`Files must be ${this.maxFileBytes} bytes or smaller.`);
  }

  private storagePath() {
    const storage = process.env.FILE_STORAGE_PATH?.trim();
    if (!storage || !isAbsolute(storage)) {
      throw new ServiceUnavailableException("Private file storage is unavailable.");
    }
    return storage;
  }

  private async remove(path: string) {
    await rm(path, { force: true }).catch(() => {
      this.logger.error("Could not remove an uncommitted file.");
    });
  }

  private async releaseReservation(ownerId: string, key: string) {
    await this.database.query(
      "DELETE FROM file_upload_reservations WHERE id = $1 AND owner_id = $2",
      [key, ownerId],
    ).catch(() => {
      this.logger.error("Could not release an upload reservation before expiry.");
    });
  }
}

export function parseFileName(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\\/\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value) > 255
  ) {
    throw new BadRequestException("Use a file name of up to 255 bytes without path separators.");
  }
  return value.trim();
}

export function parseFolderId(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new BadRequestException("Choose a valid destination folder.");
  }
  return value;
}

export function uploadTimedOut() {
  return new RequestTimeoutException("The upload expired. Try uploading the file again.");
}

function sizeMismatch() {
  return new BadRequestException("The upload did not match the declared file size. Try again.");
}

function fileNotFound() {
  return new NotFoundException("File not found.");
}

function quotaExceeded() {
  return new ConflictException("There is not enough available storage for this upload.");
}

async function requireOwnedFolder(database: Queryable, ownerId: string, folderId: string | null) {
  if (folderId === null) return;
  const result = await database.query(
    "SELECT id FROM folders WHERE owner_id = $1 AND id = $2",
    [ownerId, folderId],
  );
  if (!result.rowCount) throw new NotFoundException("Folder not found.");
}

async function lockActiveEmployee(client: PoolClient, ownerId: string) {
  const result = await client.query(
    "SELECT id FROM employees WHERE id = $1 AND active FOR UPDATE",
    [ownerId],
  );
  if (!result.rowCount) throw new UnauthorizedException("An active internal employee account is required.");
}

async function hashStoredFile(handle: FileHandle, size: number) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(256 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (bytesRead === 0) throw new Error("Stored file ended early.");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

function readLimit(name: string, limit: number) {
  const values = process.env[name]?.trim();
  if (!values) return limit;
  const parsed = Number(values);
  if (!/^\d+$/.test(values) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > limit) {
    throw new Error(`${name} must be a positive integer at most ${limit}.`);
  }
  return parsed;
}

function toPublicFile(file: FileRow) {
  return {
    id: file.id,
    name: file.original_name,
    size: Number(file.size_bytes),
    sha256: file.sha256,
    createdAt: file.created_at.toISOString(),
    folderId: file.folder_id,
    mimeType: file.mime_type,
  };
}
