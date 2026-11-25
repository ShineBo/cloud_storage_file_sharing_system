import { BadRequestException, Controller, Get, Header, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthService } from "../auth/auth.service";
import { AuditService, auditAlertFilters, auditItemId, auditOutcomes } from "./audit.service";

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
    @Res({ passthrough: true }) response: FastifyReply,
    @Query("limit") limit: unknown,
    @Query("itemId") itemId: unknown,
    @Query("searchId") searchId: unknown,
    @Query("after") after: unknown,
    @Query("outcome") outcome: unknown,
    @Query("alert") alert: unknown,
  ) {
    const reviewer = await this.auth.requireUser(request);
    const page = await this.audit.recent(reviewer.id, {
      limit: auditLimit(limit),
      itemId: optionalIdentifier(itemId, "Choose a valid audit item identifier."),
      searchId: optionalIdentifier(searchId, "Search with a valid event, item, or actor identifier."),
      after: optionalIdentifier(after, "Choose a valid activity page."),
      outcome: optionalChoice(outcome, auditOutcomes, "Choose a valid activity outcome."),
      alert: optionalChoice(alert, auditAlertFilters, "Choose a valid alert delivery filter."),
    });
    if (page.nextCursor) response.header("X-Audit-Next-Cursor", page.nextCursor);
    return { events: page.events };
  }
}

function optionalIdentifier(value: unknown, message: string) {
  const id = auditItemId(value);
  if (value !== undefined && id === null) throw new BadRequestException(message);
  return id;
}

function optionalChoice<T extends string>(value: unknown, options: readonly T[], message: string) {
  if (value === undefined) return null;
  const selected = options.find((option) => option === value);
  if (!selected) throw new BadRequestException(message);
  return selected;
}

function auditLimit(value: unknown) {
  if (value === undefined) return 50;
  if (typeof value === "string" && /^[1-9][0-9]{0,2}$/.test(value) && Number(value) <= 200) {
    return Number(value);
  }
  throw new BadRequestException("Choose an audit limit between 1 and 200.");
}
