import { Module } from "@nestjs/common";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { OidcService } from "./auth/oidc.service";
import { FilesController } from "./files/files.controller";
import { FilesService } from "./files/files.service";
import { DatabaseService } from "./database.service";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController, AuthController, FilesController],
  providers: [DatabaseService, AuthService, OidcService, FilesService],
})
export class AppModule {}
