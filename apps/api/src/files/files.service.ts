import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  StreamableFile,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import type { Multipart, MultipartFile } from "@fastify/multipart";
import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseService } from "../database.service";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

type FileRow = {
  id: string;
  original_name: string;
  size_bytes: string;
  sha256: string;
  created_at: Date;
};

type StagedUpload = { name: string; size: number; sha256: string };

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(private readonly database: DatabaseService) {}

  async list(ownerId: string) {
    const result = await this.database.query<FileRow>(
      `SELECT id, original_name, size_bytes, sha256, created_at
       FROM files WHERE owner_id = $1 ORDER BY created_at DESC, id DESC`,
      [ownerId],
    );
    return result.rows.map(toPublicFile);
  }

  async upload(ownerId: string, parts: AsyncIterable<Multipart>) {
    const storage = this.storagePath();
    const key = randomUUID();
    const stagedPath = join(storage, `${key}.upload`);
    const blobPath = join(storage, key);
    await mkdir(storage, { recursive: true, mode: 0o700 });

    try {
      let upload: StagedUpload | undefined;
      for await (const part of parts) {
        if (part.type !== "file" || part.fieldname !== "file" || upload) {
          if (part.type === "file") part.file.resume();
          throw new BadRequestException("Send a single file in the file field.");
        }
        upload = await this.stagePng(part, stagedPath);
      }

      if (!upload) {
        throw new BadRequestException("Send a single file in the file field.");
      }

      await rename(stagedPath, blobPath);
      try {
        const result = await this.database.query<FileRow>(
          `INSERT INTO files (id, owner_id, original_name, blob_key, size_bytes, sha256)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, original_name, size_bytes, sha256, created_at`,
          [randomUUID(), ownerId, upload.name, key, upload.size, upload.sha256],
        );
        return toPublicFile(result.rows[0]);
      } catch (error) {
        if (isDatabaseConstraintError(error)) {
          await this.remove(blobPath);
        } else {
          // A lost database response can follow a committed insert.
          this.logger.error("Could not confirm the file metadata insert.");
        }
        throw error;
      }
    } finally {
      await this.remove(stagedPath);
    }
  }

  async download(ownerId: string, id: string) {
    if (!UUID.test(id)) throw new NotFoundException("File not found.");

    const result = await this.database.query<FileRow & { blob_key: string }>(
      `SELECT id, original_name, size_bytes, sha256, created_at, blob_key
       FROM files WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    const file = result.rows[0];
    if (!file) throw new NotFoundException("File not found.");

    const path = join(this.storagePath(), file.blob_key);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      () => {
        this.logger.error("Could not open a stored file.");
        throw new ServiceUnavailableException("The file is temporarily unavailable.");
      },
    );

    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== Number(file.size_bytes)) {
        this.logger.error("A stored file did not match its metadata.");
        throw new ServiceUnavailableException("The file is temporarily unavailable.");
      }

      const encodedName = encodeURIComponent(file.original_name).replace(
        /['()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return new StreamableFile(handle.createReadStream(), {
        disposition: `attachment; filename="download.png"; filename*=UTF-8''${encodedName}`,
        type: "image/png",
        length: stat.size,
      });
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async stagePng(part: MultipartFile, path: string): Promise<StagedUpload> {
    const name = part.filename ?? "";
    if (
      !name.trim() ||
      /[\\/\u0000-\u001f\u007f]/.test(name) ||
      Buffer.byteLength(name) > 255
    ) {
      part.file.resume();
      throw new BadRequestException("Use a file name of up to 255 bytes without path separators.");
    }
    if (!name.toLowerCase().endsWith(".png")) {
      part.file.resume();
      throw new UnsupportedMediaTypeException("Upload a PNG image.");
    }

    const hash = createHash("sha256");
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    let size = 0;
    const inspect = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const offset = size;
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          callback();
          return;
        }
        if (offset < signature.length) {
          chunk.copy(signature, offset, 0, signature.length - offset);
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    await pipeline(
      part.file,
      inspect,
      createWriteStream(path, { flags: "wx", mode: 0o600, flush: true }),
    );
    if (part.file.truncated || size > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException("PNG uploads must be 10 MiB or smaller.");
    }
    if (size < PNG_SIGNATURE.length || !signature.equals(PNG_SIGNATURE)) {
      throw new UnsupportedMediaTypeException("Upload a PNG image with a valid file signature.");
    }
    return { name, size, sha256: hash.digest("hex") };
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
}

function toPublicFile(file: FileRow) {
  return {
    id: file.id,
    name: file.original_name,
    size: Number(file.size_bytes),
    sha256: file.sha256,
    createdAt: file.created_at.toISOString(),
  };
}

function isDatabaseConstraintError(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^23[0-9A-Z]{3}$/.test(error.code)
  );
}
