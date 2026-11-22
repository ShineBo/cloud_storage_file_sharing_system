import { applyDecorators, Controller, Get, Header, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthService } from "../auth/auth.service";
import { FilesService } from "../files/files.service";
import { SharesService, toSharedFile } from "./shares.service";

function PrivateContent() {
  return applyDecorators(
    Header("Cache-Control", "private, no-store"),
    Header("Referrer-Policy", "no-referrer"),
    Header("X-Content-Type-Options", "nosniff"),
    Header("X-Frame-Options", "SAMEORIGIN"),
  );
}

@Controller("shared")
export class SharedContentController {
  constructor(
    private readonly auth: AuthService,
    private readonly shares: SharesService,
    private readonly files: FilesService,
  ) {}

  @Get(":id")
  @PrivateContent()
  async browse(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
    @Query("folderId") folderId: unknown,
  ) {
    const user = await this.auth.requireUser(request);
    return this.shares.browse(user.id, id, folderId);
  }

  @Get(":id/files/:fileId/view")
  @PrivateContent()
  async view(@Req() request: FastifyRequest, @Param("id") id: string, @Param("fileId") fileId: string) {
    const user = await this.auth.requireUser(request);
    const file = await this.shares.authorizeFile(user.id, id, fileId, "view");
    return this.files.serveAuthorized(file, "view");
  }

  @Get(":id/files/:fileId/download")
  @PrivateContent()
  async download(@Req() request: FastifyRequest, @Param("id") id: string, @Param("fileId") fileId: string) {
    const user = await this.auth.requireUser(request);
    const file = await this.shares.authorizeFile(user.id, id, fileId, "download");
    return this.files.serveAuthorized(file, "download");
  }

  @Post(":id/files/:fileId/edit")
  @HttpCode(200)
  @PrivateContent()
  async edit(@Req() request: FastifyRequest, @Param("id") id: string, @Param("fileId") fileId: string) {
    const user = await this.auth.requireUser(request);
    this.auth.requireSameOrigin(request);
    const file = await this.shares.authorizeFile(user.id, id, fileId, "edit");
    return { file: { ...toSharedFile(file), sha256: file.sha256 } };
  }
}
