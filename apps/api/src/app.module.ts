import { Module } from "@nestjs/common";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { OidcService } from "./auth/oidc.service";
import { FilesController } from "./files/files.controller";
import { FilesService } from "./files/files.service";
import { FoldersController } from "./folders/folders.controller";
import { FoldersService } from "./folders/folders.service";
import { DatabaseService } from "./database.service";
import { HealthController } from "./health.controller";
import { SharedContentController } from "./shares/shared-content.controller";
import { SharesController } from "./shares/shares.controller";
import { SharesService } from "./shares/shares.service";

@Module({
  controllers: [
    HealthController, AuthController, FilesController, FoldersController, SharesController, SharedContentController,
  ],
  providers: [DatabaseService, AuthService, OidcService, FilesService, FoldersService, SharesService],
})
export class AppModule {}
