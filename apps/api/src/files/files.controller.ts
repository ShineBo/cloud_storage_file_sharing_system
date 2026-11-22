import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import type { FastifyMultipartBaseOptions } from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import { AuthService } from "../auth/auth.service";
import {
  FilesService,
  parseFileName,
  parseFolderId,
  UPLOAD_TIMEOUT_MS,
  uploadTimedOut,
} from "./files.service";

@Controller("files")
export class FilesController {
  constructor(
    private readonly auth: AuthService,
    private readonly files: FilesService,
  ) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  async list(@Req() request: FastifyRequest, @Query("folderId") folderId: unknown) {
    const user = await this.auth.requireUser(request);
    return { files: await this.files.list(user.id, parseFolderId(folderId)) };
  }

  @Get("policy")
  @Header("Cache-Control", "private, no-store")
  async policy(@Req() request: FastifyRequest) {
    const user = await this.auth.requireUser(request);
    return this.files.policy(user.id);
  }

  @Post()
  @Header("Cache-Control", "private, no-store")
  async upload(
    @Req() request: FastifyRequest,
    @Query("folderId") folderId: unknown,
    @Query("size") size: unknown,
  ) {
    const user = await this.auth.requireUser(request);
    this.auth.requireSameOrigin(request);
    if (!request.isMultipart()) {
      throw new UnsupportedMediaTypeException("Send a multipart file upload.");
    }

    const destination = parseFolderId(folderId);
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
      const file = await this.files.upload(user.id, {
        folderId: destination,
        declaredSize,
        expiresAt,
        signal: cancel.signal,
        parts: (limit) => {
          const options: FastifyMultipartBaseOptions = {
            // Busboy marks its boundary as truncated.
            limits: { files: 1, fields: 0, fileSize: limit + 1 },
            throwFileSizeLimit: false,
          };
          return request.parts(options);
        },
      });
      return { file };
    } finally {
      clearTimeout(deadline);
      request.raw.off("aborted", onAborted);
    }
  }

  @Patch(":id")
  @Header("Cache-Control", "private, no-store")
  async update(@Req() request: FastifyRequest, @Param("id") id: string, @Body() body: unknown) {
    const user = await this.auth.requireUser(request);
    this.auth.requireSameOrigin(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new BadRequestException("Send a file name or destination to update.");
    }
    const name = "name" in body ? parseFileName(body.name) : undefined;
    const folderId = "folderId" in body ? parseFolderId(body.folderId) : undefined;
    if (name === undefined && folderId === undefined) {
      throw new BadRequestException("Send a file name or destination to update.");
    }
    return { file: await this.files.update(user.id, id, { name, folderId }) };
  }

  @Get(":id/download")
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  async download(@Req() request: FastifyRequest, @Param("id") id: string) {
    const user = await this.auth.requireUser(request);
    return this.files.download(user.id, id);
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
