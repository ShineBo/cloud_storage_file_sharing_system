import { BadRequestException, Body, Controller, Get, Header, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { FilesService, parseFileName, parseFolderId } from "./files.service";
import { readBaseRevision, receiveUpload } from "./multipart-upload";

@Controller("files")
export class FilesController {
  constructor(
    private readonly auth: AuthService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
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
    return this.audit.run({ action: "upload", actorId: null, itemType: "file" }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      this.auth.requireSameOrigin(request);
      const destination = parseFolderId(folderId);
      const file = await receiveUpload(request, size, (transfer) =>
        this.files.upload(user.id, { ...transfer, folderId: destination }, event));
      return { file };
    }, null);
  }

  @Post(":id/revisions")
  @Header("Cache-Control", "private, no-store")
  async replace(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
    @Query("baseRevision") baseRevision: unknown,
    @Query("size") size: unknown,
  ) {
    return this.audit.run({ action: "edit", actorId: null, itemType: "file", itemId: id }, async (event) => {
      const owner = await this.auth.requireUser(request);
      event.actorId = owner.id;
      this.auth.requireSameOrigin(request);
      const revision = readBaseRevision(baseRevision);
      event.revision = revision;
      const file = await receiveUpload(request, size, (transfer) =>
        this.files.replace(owner.id, id, revision, transfer, async (client) => {
          await this.auth.requireUser(request, client);
        }, event));
      return { file };
    }, null);
  }

  @Patch(":id")
  @Header("Cache-Control", "private, no-store")
  async update(@Req() request: FastifyRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.audit.run({ action: "file.update", actorId: null, itemType: "file", itemId: id }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      this.auth.requireSameOrigin(request);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new BadRequestException("Send a file name or destination to update.");
      }
      const name = "name" in body ? parseFileName(body.name) : undefined;
      const folderId = "folderId" in body ? parseFolderId(body.folderId) : undefined;
      if (name === undefined && folderId === undefined) {
        throw new BadRequestException("Send a file name or destination to update.");
      }
      return { file: await this.files.update(user.id, id, { name, folderId }, event) };
    }, null);
  }

  @Get(":id/view")
  @Header("Cache-Control", "private, no-store")
  @Header("Referrer-Policy", "no-referrer")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("X-Frame-Options", "SAMEORIGIN")
  async view(@Req() request: FastifyRequest, @Param("id") id: string) {
    return this.serveOwnedFile(request, id, "view");
  }

  @Get(":id/download")
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  async download(@Req() request: FastifyRequest, @Param("id") id: string) {
    return this.serveOwnedFile(request, id, "download");
  }

  private serveOwnedFile(request: FastifyRequest, id: string, action: "view" | "download") {
    return this.audit.run({ action, actorId: null, itemType: "file", itemId: id }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      return this.files.serveOwned(user.id, id, action, event);
    });
  }
}
