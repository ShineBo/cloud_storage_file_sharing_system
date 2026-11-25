import {
  Controller,
  Get,
  Header,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service";
import { SharesService } from "../shares/shares.service";
import { logoutStatePrefix } from "./auth-cookies";
import { AuthService, shareLoginPath } from "./auth.service";

@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly shares: SharesService,
    private readonly audit: AuditService,
  ) {}

  @Get("login")
  async login(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query("share") share: unknown,
  ) {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    try {
      const { location, cookie } = await this.auth.beginLogin(request, share);
      return reply.header("Set-Cookie", cookie).redirect(location, 302);
    } catch {
      this.logger.warn("Could not start sign-in.");
      return reply.redirect(`${shareLoginPath(share)}?auth=unavailable`, 302);
    }
  }

  @Get("callback")
  async callback(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    const params = new URL(request.url, "http://localhost").searchParams;
    const state = params.getAll("state").find((value) => value.startsWith(logoutStatePrefix));
    if (state) {
      if (params.size === 1) {
        try {
          const cookies = await this.auth.finishSignOut(request, state);
          if (cookies) reply.header("Set-Cookie", cookies);
        } catch {
          this.logger.warn("Could not complete sign-out.");
        }
      }
      return reply.redirect("/", 302);
    }
    if (params.size === 1 && params.get("state") === "signed-out") {
      return reply.redirect("/", 302);
    }
    try {
      reply.header("Set-Cookie", this.auth.clearLoginCookie());
      const result = await this.auth.finishLogin(request);
      if (result?.cookie) {
        return reply.header("Set-Cookie", result.cookie).redirect(result.location, 302);
      }
      if (result?.outcome === "unavailable") this.logger.warn("Could not complete sign-in.");
      if (result?.outcome === "denied" && result.location.startsWith("/shared/")) {
        const shareId = result.location.slice("/shared/".length);
        if (await this.shares.recordAccessFailure(shareId)) {
          await this.audit.record({ action: "share.open", actorId: null, itemType: "share", outcome: "denied", status: 401 })
            .catch(() => undefined);
        }
      }
      return reply.redirect(`${result?.location ?? "/"}?auth=${result?.outcome ?? "denied"}`, 302);
    } catch {
      this.logger.warn("Could not complete sign-in.");
      return reply.redirect("/?auth=unavailable", 302);
    }
  }

  @Get("me")
  @Header("Cache-Control", "no-store")
  async me(@Req() request: FastifyRequest) {
    return { user: await this.auth.profile(request) };
  }

  @Post("logout")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { cookies, location } = await this.auth.signOut(request);
    reply.header("Set-Cookie", cookies);
    if (location) reply.header("X-Sign-Out-Location", location);
  }
}
