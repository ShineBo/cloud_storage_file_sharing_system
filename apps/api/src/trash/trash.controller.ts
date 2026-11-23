import { Body, Controller, Get, Header, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { TrashService } from "./trash.service";

@Controller("trash")
export class TrashController {
  constructor(
    private readonly auth: AuthService,
    private readonly trash: TrashService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  async list(@Req() request: FastifyRequest) {
    const user = await this.auth.requireUser(request);
    return { items: await this.trash.list(user.id) };
  }

  @Post()
  @Header("Cache-Control", "private, no-store")
  async remove(@Req() request: FastifyRequest, @Body() input: unknown) {
    return this.audit.run({ action: "item.delete", actorId: null, itemType: "file" }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      this.auth.requireSameOrigin(request);
      return { item: await this.trash.remove(user.id, input, event) };
    }, null);
  }

  @Post(":id/restore")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async restore(@Req() request: FastifyRequest, @Param("id") id: string) {
    return this.audit.run({ action: "item.restore", actorId: null, itemType: "file" }, async (event) => {
      const user = await this.auth.requireUser(request);
      event.actorId = user.id;
      this.auth.requireSameOrigin(request);
      return { item: await this.trash.restore(user.id, id, event) };
    }, null);
  }
}
