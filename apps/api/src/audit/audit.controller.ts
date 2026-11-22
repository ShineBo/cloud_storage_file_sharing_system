import { BadRequestException, Controller, Get, Header, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthService } from "../auth/auth.service";
import { AuditService, auditItemId } from "./audit.service";

@Controller("audit")
export class AuditController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  async recent(
    @Req() request: FastifyRequest,
    @Query("limit") limit: unknown,
    @Query("itemId") itemId: unknown,
  ) {
    const reviewer = await this.auth.requireUser(request);
    const selectedItem = auditItemId(itemId);
    if (itemId !== undefined && selectedItem === null) {
      throw new BadRequestException("Choose a valid audit item identifier.");
    }
    return { events: await this.audit.recent(reviewer.id, auditLimit(limit), selectedItem) };
  }
}

function auditLimit(value: unknown) {
  if (value === undefined) return 50;
  if (typeof value === "string" && /^[1-9][0-9]{0,2}$/.test(value) && Number(value) <= 200) {
    return Number(value);
  }
  throw new BadRequestException("Choose an audit limit between 1 and 200.");
}
