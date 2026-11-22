import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthService } from "../auth/auth.service";
import { SharesService } from "./shares.service";

@Controller("shares")
export class SharesController {
  constructor(
    private readonly auth: AuthService,
    private readonly shares: SharesService,
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
    const user = await this.auth.requireUser(request);
    this.auth.requireSameOrigin(request);
    return { share: await this.shares.create(user.id, body) };
  }

  @Post(":id/revoke")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async revoke(@Req() request: FastifyRequest, @Param("id") id: string) {
    const user = await this.auth.requireUser(request);
    this.auth.requireSameOrigin(request);
    return { share: await this.shares.revoke(user.id, id) };
  }
}
