import { applyDecorators, Controller, Get, Header, HttpCode, HttpException, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuditService, type AuditAttempt } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { FilesService } from "../files/files.service";
import { readBaseRevision, receiveUpload } from "../files/multipart-upload";
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
    private readonly audit: AuditService,
  ) {}

  @Get(":id")
  @PrivateContent()
  async browse(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
    @Query("folderId") folderId: unknown,
  ) {
    return this.audit.run({ action: "share.open", actorId: null, itemType: "share" }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      const contents = await this.trackAccess(id, event, () => this.shares.browse(user.id, id, folderId));
      event.itemType = contents.item.type;
      event.itemId = contents.item.id;
      if (contents.item.type === "file") event.revision = contents.item.revision;
      return contents;
    });
  }

  @Get(":id/files/:fileId/view")
  @PrivateContent()
  async view(@Req() request: FastifyRequest, @Param("id") id: string, @Param("fileId") fileId: string) {
    return this.serve(request, id, fileId, "view");
  }

  @Get(":id/files/:fileId/download")
  @PrivateContent()
  async download(@Req() request: FastifyRequest, @Param("id") id: string, @Param("fileId") fileId: string) {
    return this.serve(request, id, fileId, "download");
  }

  @Post(":id/files/:fileId/edit")
  @HttpCode(200)
  @PrivateContent()
  async edit(@Req() request: FastifyRequest, @Param("id") id: string, @Param("fileId") fileId: string) {
    return this.audit.run({ action: "edit.prepare", actorId: null, itemType: "file", itemId: fileId }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      this.auth.requireSameOrigin(request);
      const file = await this.trackAccess(id, event, () => this.shares.authorizeFile(user.id, id, fileId, "edit"));
      event.revision = file.revision;
      return { file: { ...toSharedFile(file), sha256: file.sha256 } };
    });
  }

  @Post(":id/files/:fileId/revisions")
  @PrivateContent()
  async replace(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
    @Param("fileId") fileId: string,
    @Query("baseRevision") baseRevision: unknown,
    @Query("size") size: unknown,
  ) {
    return this.audit.run({ action: "edit", actorId: null, itemType: "file", itemId: fileId }, async (event) => {
      const editor = await this.auth.requireUser(request);
      event.actorId = editor.id;
      this.auth.requireSameOrigin(request);
      const revision = readBaseRevision(baseRevision);
      event.revision = revision;
      const file = await this.trackAccess(id, event, async () => {
        const current = await this.shares.authorizeFile(editor.id, id, fileId, "edit");
        return receiveUpload(request, size, (transfer) =>
          this.files.replace(current.owner_id, fileId, revision, transfer, async (client) => {
            await this.auth.requireUser(request, client);
            await this.shares.authorizeFile(editor.id, id, fileId, "edit", client);
          }, event));
      });
      return { file };
    }, null);
  }

  private async serve(request: FastifyRequest, id: string, fileId: string, action: "view" | "download") {
    return this.audit.run({ action, actorId: null, itemType: "file", itemId: fileId }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      const file = await this.trackAccess(id, event, () => this.shares.authorizeFile(user.id, id, fileId, action));
      event.revision = file.revision;
      return this.files.serveAuthorized(file, action);
    });
  }

  private async trackAccess<T>(id: string, event: AuditAttempt, access: () => Promise<T>): Promise<T> {
    try {
      return await access();
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : undefined;
      if (event.actorId && (status === 403 || status === 404 || status === 410)) {
        if (await this.shares.recordAccessFailure(id)) {
          event.risk = status === 410 ? "inactive-share-access" : "denied-shared-access";
        }
      }
      throw error;
    }
  }
}
