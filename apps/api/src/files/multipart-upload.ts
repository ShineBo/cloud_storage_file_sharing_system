import { BadRequestException, UnsupportedMediaTypeException } from "@nestjs/common";
import type { FastifyMultipartBaseOptions, Multipart } from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import { UPLOAD_TIMEOUT_MS, uploadTimedOut } from "./files.service";

type Transfer = {
  declaredSize: number | undefined;
  expiresAt: Date;
  signal: AbortSignal;
  parts: (limit: number) => AsyncIterable<Multipart>;
};

export async function receiveUpload<T>(
  request: FastifyRequest,
  size: unknown,
  consume: (transfer: Transfer) => Promise<T>,
) {
  if (!request.isMultipart()) throw new UnsupportedMediaTypeException("Send a multipart file upload.");

  const declaredSize = parseDeclaredSize(size);
  const cancel = new AbortController();
  const expiresAt = new Date(Date.now() + UPLOAD_TIMEOUT_MS);
  const onAborted = () => cancel.abort(uploadTimedOut());
  const deadline = setTimeout(() => {
    onAborted();
    if (!request.raw.complete) request.raw.destroy();
  }, UPLOAD_TIMEOUT_MS);
  deadline.unref();
  request.raw.once("aborted", onAborted);
  if (request.raw.aborted) onAborted();

  try {
    return await consume({
      declaredSize,
      expiresAt,
      signal: cancel.signal,
      parts: (limit) => {
        // Busboy marks its boundary as truncated.
        const options: FastifyMultipartBaseOptions = {
          limits: { files: 1, fields: 0, fileSize: limit + 1 },
          throwFileSizeLimit: false,
        };
        return request.parts(options);
      },
    });
  } finally {
    clearTimeout(deadline);
    request.raw.off("aborted", onAborted);
  }
}

function parseDeclaredSize(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const size = Number(value);
    if (Number.isSafeInteger(size) && size > 0) return size;
  }
  throw new BadRequestException("Declare the file size as a positive number of bytes.");
}

export function readBaseRevision(value: unknown) {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const revision = Number(value);
    if (Number.isInteger(revision) && revision > 0 && revision < 2_147_483_647) return revision;
  }
  throw new BadRequestException("Provide the version number you opened before publishing.");
}
