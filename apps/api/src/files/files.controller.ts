import {
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import type { FastifyMultipartBaseOptions } from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import { AuthService } from "../auth/auth.service";
import { FilesService, MAX_UPLOAD_BYTES } from "./files.service";

@Controller("files")
export class FilesController {
  constructor(
    private readonly auth: AuthService,
    private readonly files: FilesService,
  ) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  async list(@Req() request: FastifyRequest) {
    const user = await this.auth.requireUser(request);
    return { files: await this.files.list(user.id) };
  }

  @Post()
  @Header("Cache-Control", "private, no-store")
  async upload(@Req() request: FastifyRequest) {
    const user = await this.auth.requireUser(request);
    this.auth.requireSameOrigin(request);
    if (!request.isMultipart()) {
      throw new UnsupportedMediaTypeException("Send a multipart file upload.");
    }

    const options: FastifyMultipartBaseOptions = {
      // Busboy marks its boundary as truncated, so leave room for a byte past the accepted size.
      limits: { files: 1, fields: 0, fileSize: MAX_UPLOAD_BYTES + 1 },
      throwFileSizeLimit: false,
    };
    return { file: await this.files.upload(user.id, request.parts(options)) };
  }

  @Get(":id/download")
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  async download(@Req() request: FastifyRequest, @Param("id") id: string) {
    const user = await this.auth.requireUser(request);
    return this.files.download(user.id, id);
  }
}
