import { Body, Controller, Get, Header, Param, Patch, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { PolicyService } from "./policy.service";

@Controller("admin")
export class PoliciesController {
  constructor(
    private readonly auth: AuthService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  @Get("policy")
  @Header("Cache-Control", "private, no-store")
  async getPolicy(@Req() request: FastifyRequest) {
    const admin = await this.auth.requireUser(request);
    return { policy: await this.policy.adminPolicy(admin.id) };
  }

  @Patch("policy")
  @Header("Cache-Control", "private, no-store")
  async updatePolicy(@Req() request: FastifyRequest, @Body() input: unknown) {
    return this.audit.run({ action: "policy.update", actorId: null, itemType: "policy" }, async (event) => {
      const admin = await this.auth.requireUser(request);
      event.actorId = admin.id;
      this.auth.requireSameOrigin(request);
      return { policy: await this.policy.updatePolicy(admin.id, input, event) };
    }, null);
  }

  @Get("accounts")
  @Header("Cache-Control", "private, no-store")
  async accounts(@Req() request: FastifyRequest) {
    const admin = await this.auth.requireUser(request);
    return { accounts: await this.policy.accounts(admin.id) };
  }

  @Patch("accounts/:id")
  @Header("Cache-Control", "private, no-store")
  async updateAccount(@Req() request: FastifyRequest, @Param("id") id: string, @Body() input: unknown) {
    return this.audit.run({ action: "account.update", actorId: null, itemType: "employee", itemId: id }, async (event) => {
      const admin = await this.auth.requireUser(request);
      event.actorId = admin.id;
      this.auth.requireSameOrigin(request);
      return { account: await this.policy.updateAccount(admin.id, id, input, event) };
    }, null);
  }
}
