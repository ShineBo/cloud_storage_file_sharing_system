import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { FoldersService } from "./folders.service";

@Controller("folders")
export class FoldersController {
  constructor(
    private readonly auth: AuthService,
    private readonly folders: FoldersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  async list(@Req() request: FastifyRequest) {
    const user = await this.auth.requireUser(request);
    return { folders: await this.folders.list(user.id) };
  }

  @Post()
  @Header("Cache-Control", "private, no-store")
  async create(@Req() request: FastifyRequest, @Body() input: unknown) {
    return this.audit.run({ action: "folder.create", actorId: null, itemType: "folder" }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      this.auth.requireSameOrigin(request);
      return { folder: await this.folders.create(user.id, input, event.eventId) };
    }, null);
  }

  @Patch(":id")
  @Header("Cache-Control", "private, no-store")
  async update(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    return this.audit.run({ action: "folder.update", actorId: null, itemType: "folder", itemId: id }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      this.auth.requireSameOrigin(request);
      return { folder: await this.folders.update(user.id, id, input, event.eventId) };
    }, null);
  }
}
