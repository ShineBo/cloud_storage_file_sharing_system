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
import { AuditService, type AuditAttempt } from "../audit/audit.service";
import { DatabaseService } from "../database.service";
import { expectedFileType, verifyFileType } from "./file-media";
import { officePreview } from "./office-preview";

const DEFAULT_MAX_FILE_BYTES = 2_000_000_000;
const DEFAULT_QUOTA_BYTES = 20_000_000_000;
export const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FILE_COLUMNS = `id, original_name, folder_id, size_bytes, sha256, mime_type, created_at,
                      revision, author_name, revised_at`;

type FileRow = {
  id: string;
  original_name: string;
  folder_id: string | null;
  size_bytes: string;
  sha256: string;
  mime_type: string;
  created_at: Date;
  revision: number;
  author_name: string;
  revised_at: Date;
};

export type StoredBlob = Pick<FileRow, "original_name" | "size_bytes" | "sha256" | "mime_type"> & {
  blob_key: string;
};

export type TransferContext = {
  declaredSize: number | undefined;
  expiresAt: Date;
  signal: AbortSignal;
  parts: (limit: number) => AsyncIterable<Multipart>;
};

type UploadContext = TransferContext & { folderId: string | null };
type FileChanges = { name?: string; folderId?: string | null };
type Reservation = { bytes: number; expiredIds: string[] };
type StagedFile = { name: string; size: number; sha256: string; mimeType: string };
type Queryable = Pick<DatabaseService, "query">;
type UploadValidation<T> = (client: PoolClient) => Promise<T>;

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly maxFileBytes = readLimit("FILE_MAX_BYTES", DEFAULT_MAX_FILE_BYTES);
  private readonly quotaBytes = readLimit("FILE_QUOTA_BYTES", DEFAULT_QUOTA_BYTES);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(ownerId: string, folderId: string | null) {
    await requireOwnedFolder(this.database, ownerId, folderId);
    const result = await this.database.query<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM current_files WHERE owner_id = $1
         AND folder_id IS NOT DISTINCT FROM $2::uuid ORDER BY created_at DESC, id DESC`,
      [ownerId, folderId],
    );
    return result.rows.map(toPublicFile);
  }

  async policy(ownerId: string) {
    const usage = await this.readUsage(this.database, ownerId);
    return { maxFileBytes: this.maxFileBytes, quotaBytes: this.quotaBytes, ...usage };
  }

  async upload(ownerId: string, context: UploadContext, auditEntry?: AuditAttempt) {
    const { folderId } = context;
    return this.saveUpload(
      ownerId, ownerId, context,
      (client) => requireOwnedFolder(client, ownerId, folderId),
      async (client, _, completed, key) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO files (id, owner_id, folder_id, original_name) VALUES ($1, $2, $3, $4)`,
          [id, ownerId, folderId, completed.name],
        );
        await this.insertRevision(client, id, 1, ownerId, completed, key);
        if (auditEntry) {
          await this.audit.record({
            ...auditEntry, actorId: ownerId, itemType: "file", itemId: id, revision: 1,
            outcome: "success", status: 201,
          }, client);
        }
        return this.findCurrent(client, ownerId, id);
      },
    );
  }

  async replace(
    ownerId: string,
    fileId: string,
    baseRevision: number,
    context: TransferContext,
    authorize: UploadValidation<void>,
    auditEntry: AuditAttempt,
  ) {
    if (!UUID.test(fileId)) throw fileNotFound();
    if (!Number.isInteger(baseRevision) || baseRevision < 1 || baseRevision >= 2_147_483_647) {
      throw new BadRequestException("Choose a valid file revision before publishing.");
    }
    const authorId = auditEntry.actorId;
    if (!authorId) throw new UnauthorizedException("An active internal employee account is required.");

    return this.saveUpload(
      ownerId, authorId, context,
      async (client) => {
        await this.lockFile(client, ownerId, fileId);
        await authorize(client);
        const current = await this.findCurrent(client, ownerId, fileId);
        if (current.revision !== baseRevision) {
          throw new ConflictException({
            code: "STALE_REVISION",
            message: "This file has a newer revision. Reload it before publishing.",
          });
        }
        return current;
      },
      async (client, current, completed, key) => {
        if (completed.mimeType !== current.mime_type) {
          throw new UnsupportedMediaTypeException("Choose a replacement with the file's original type.");
        }
        const revision = baseRevision + 1;
        await this.insertRevision(client, fileId, revision, authorId, completed, key);
        await client.query("UPDATE files SET current_revision = $2 WHERE id = $1", [fileId, revision]);
        await this.audit.record({
          ...auditEntry, actorId: authorId, itemType: "file", itemId: fileId, revision,
          outcome: "success", status: 201,
        }, client);
        return this.findCurrent(client, ownerId, fileId);
      },
    );
  }

  private async saveUpload<T>(
    ownerId: string,
    authorId: string,
    context: TransferContext,
    validateTarget: UploadValidation<T>,
    publish: (client: PoolClient, target: T, upload: StagedFile, key: string) => Promise<FileRow>,
  ) {
    const { declaredSize, signal } = context;
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
      const reservation = await this.reserve(ownerId, authorId, key, context, validateTarget);
      // An expired reservation was never consumed by a committed publication.
      await Promise.all(reservation.expiredIds.flatMap((id) => [
        this.remove(join(storage, `${id}.upload`)),
        this.remove(join(storage, id)),
      ]));
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
        await lockActiveEmployees(client, ownerId, authorId);
        const target = await validateTarget(client);
        const active = await client.query(
          `DELETE FROM file_upload_reservations
           WHERE id = $1 AND owner_id = $2 AND expires_at > clock_timestamp() RETURNING id`,
          [key, ownerId],
        );
        if (!active.rowCount) throw uploadTimedOut();
        signal.throwIfAborted();
        await rename(stagedPath, blobPath);
        publishedBlob = true;
        const directory = await open(storage, constants.O_RDONLY | constants.O_DIRECTORY);
        await directory.sync().finally(() => directory.close());
        const saved = await publish(client, target, completed, key);
        signal.throwIfAborted();
        mayHaveCommitted = true;
        return saved;
      });
      return toPublicFile(row);
    } catch (error) {
      if (publishedBlob && !mayHaveCommitted) {
        await this.remove(blobPath);
      } else if (publishedBlob) {
        await this.reconcilePublication(ownerId, key, blobPath);
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

  async update(ownerId: string, id: string, changes: FileChanges, auditEntry?: AuditAttempt) {
    if (!UUID.test(id)) throw fileNotFound();
    return this.database.transaction(async (client) => {
      await lockActiveEmployees(client, ownerId, ownerId);
      await this.lockFile(client, ownerId, id);
      const file = await this.findCurrent(client, ownerId, id);

      const name = changes.name ?? file.original_name;
      if (changes.name !== undefined && expectedFileType(name).mimeType !== file.mime_type) {
        throw new UnsupportedMediaTypeException("Keep the extension for this file's original type.");
      }
      const folderId = changes.folderId === undefined ? file.folder_id : changes.folderId;
      await requireOwnedFolder(client, ownerId, folderId);
      await client.query(
        `UPDATE files SET original_name = $3, folder_id = $4 WHERE owner_id = $1 AND id = $2`,
        [ownerId, id, name, folderId],
      );
      if (auditEntry) {
        await this.audit.record({
          ...auditEntry, actorId: ownerId, itemType: "file", itemId: id, revision: file.revision,
          outcome: "success", status: 200,
        }, client);
      }
      return toPublicFile({ ...file, original_name: name, folder_id: folderId });
    });
  }

  async download(ownerId: string, id: string, auditEntry?: AuditAttempt) {
    if (!UUID.test(id)) throw fileNotFound();
    const file = await this.findCurrent(this.database, ownerId, id);
    if (auditEntry) auditEntry.revision = file.revision;
    return this.serveAuthorized(file, "download");
  }

  private async insertRevision(
    client: PoolClient, fileId: string, revision: number, authorId: string, file: StagedFile, key: string,
  ) {
    await client.query(
      `INSERT INTO file_revisions (file_id, revision, author_id, blob_key, size_bytes, sha256, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [fileId, revision, authorId, key, file.size, file.sha256, file.mimeType],
    );
  }

  private async findCurrent(database: Queryable, ownerId: string, id: string) {
    const result = await database.query<FileRow & { blob_key: string }>(
      `SELECT ${FILE_COLUMNS}, blob_key FROM current_files WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    const file = result.rows[0];
    if (!file) throw fileNotFound();
    return file;
  }

  private async lockFile(client: PoolClient, ownerId: string, id: string) {
    const result = await client.query("SELECT id FROM files WHERE owner_id = $1 AND id = $2 FOR UPDATE", [ownerId, id]);
    if (!result.rowCount) throw fileNotFound();
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

  private async reserve(
    ownerId: string, authorId: string, key: string, context: TransferContext,
    validateTarget: UploadValidation<unknown>,
  ): Promise<Reservation> {
    return this.database.transaction(async (client) => {
      await lockActiveEmployees(client, ownerId, authorId);
      await validateTarget(client);
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
         (SELECT COALESCE(SUM(revision.size_bytes), 0)::text FROM file_revisions AS revision
          JOIN files ON files.id = revision.file_id WHERE files.owner_id = $1) AS used,
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

  private async reconcilePublication(ownerId: string, key: string, path: string) {
    // The original write might have committed before the database connection closed.
    await this.database.transaction(async (client) => {
      await client.query("SELECT id FROM employees WHERE id = $1 FOR UPDATE", [ownerId]);
      const published = await client.query("SELECT 1 FROM file_revisions WHERE blob_key = $1", [key]);
      if (!published.rowCount) await this.remove(path);
    }).catch(() => {
      this.logger.error("Could not reconcile a file after an unconfirmed publish.");
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

async function lockActiveEmployees(client: PoolClient, ownerId: string, authorId: string) {
  // Lock in UUID order so two employees can safely replace each other's shared files.
  const result = await client.query(
    "SELECT id FROM employees WHERE id IN ($1, $2) AND active ORDER BY id FOR UPDATE",
    [ownerId, authorId],
  );
  const expected = ownerId === authorId ? 1 : 2;
  if (result.rowCount !== expected) {
    throw new UnauthorizedException("An active internal employee account is required.");
  }
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
    revision: file.revision,
    authorName: file.author_name,
    revisedAt: file.revised_at.toISOString(),
  };
}
