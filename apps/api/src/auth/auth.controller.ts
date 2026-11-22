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
import { AuthService, shareLoginPath } from "./auth.service";

@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly auth: AuthService) {}

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
    try {
      reply.header("Set-Cookie", this.auth.clearLoginCookie());
      const result = await this.auth.finishLogin(request);
      if (result?.cookie) {
        return reply.header("Set-Cookie", result.cookie).redirect(result.location, 302);
      }
      if (result?.outcome === "unavailable") this.logger.warn("Could not complete sign-in.");
      return reply.redirect(`${result?.location ?? "/"}?auth=${result?.outcome ?? "denied"}`, 302);
    } catch {
      this.logger.warn("Could not complete sign-in.");
      return reply.redirect("/?auth=unavailable", 302);
    }
  }

  @Get("me")
  @Header("Cache-Control", "no-store")
  async me(@Req() request: FastifyRequest) {
    return { user: await this.auth.requireUser(request) };
  }

  @Post("logout")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const cookies = await this.auth.signOut(request);
    reply.header("Set-Cookie", cookies);
  }
}
