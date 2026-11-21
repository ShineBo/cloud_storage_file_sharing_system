import {
  Controller,
  Get,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DatabaseService } from "./database.service";

@Controller()
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    if (!(await this.database.isReady())) {
      throw new ServiceUnavailableException({ status: "unavailable" });
    }

    return { status: "ready" };
  }
}
