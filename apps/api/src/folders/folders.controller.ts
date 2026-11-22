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
import { AuthService } from "../auth/auth.service";
import { FoldersService } from "./folders.service";

@Controller("folders")
export class FoldersController {
  constructor(
    private readonly auth: AuthService,
    private readonly folders: FoldersService,
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
    const user = await this.auth.requireUser(request);
    this.auth.requireSameOrigin(request);
    return { folder: await this.folders.create(user.id, input) };
  }

  @Patch(":id")
  @Header("Cache-Control", "private, no-store")
  async update(
    @Req() request: FastifyRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    const user = await this.auth.requireUser(request);
    this.auth.requireSameOrigin(request);
    return { folder: await this.folders.update(user.id, id, input) };
  }
}
