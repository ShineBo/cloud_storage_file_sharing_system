import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { SharesService } from "./shares.service";

@Controller("shares")
export class SharesController {
  constructor(
    private readonly auth: AuthService,
    private readonly shares: SharesService,
    private readonly audit: AuditService,
  ) {}

  @Get("recipients")
  @Header("Cache-Control", "private, no-store")
  async recipients(@Req() request: FastifyRequest) {
    const user = await this.auth.requireUser(request);
    return this.shares.recipients(user.id);
  }

  @Get()
  @Header("Cache-Control", "private, no-store")
  async list(
    @Req() request: FastifyRequest,
    @Query("itemType") itemType: unknown,
    @Query("itemId") itemId: unknown,
  ) {
    const user = await this.auth.requireUser(request);
    return { shares: await this.shares.list(user.id, itemType, itemId) };
  }

  @Post()
  @Header("Cache-Control", "private, no-store")
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.audit.run({ action: "share.create", actorId: null, itemType: "share" }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      this.auth.requireSameOrigin(request);
      return { share: await this.shares.create(user.id, body, event) };
    }, null);
  }

  @Post(":id/delivery/retry")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async retryDelivery(@Req() request: FastifyRequest, @Param("id") id: string) {
    const user = await this.auth.requireUser(request);
    this.auth.requireSameOrigin(request);
    return { share: await this.shares.retryDelivery(user.id, id) };
  }

  @Post(":id/revoke")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async revoke(@Req() request: FastifyRequest, @Param("id") id: string) {
    return this.audit.run({ action: "share.revoke", actorId: null, itemType: "share" }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      this.auth.requireSameOrigin(request);
      return { share: await this.shares.revoke(user.id, id, event) };
    }, null);
  }
}
