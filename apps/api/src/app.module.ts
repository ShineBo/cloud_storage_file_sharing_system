import { Module } from "@nestjs/common";
import { AuditController } from "./audit/audit.controller";
import { AuditService } from "./audit/audit.service";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { OidcService } from "./auth/oidc.service";
import { FilesController } from "./files/files.controller";
import { FilesService } from "./files/files.service";
import { FoldersController } from "./folders/folders.controller";
import { FoldersService } from "./folders/folders.service";
import { DatabaseService } from "./database.service";
import { HealthController } from "./health.controller";
import { NotificationService } from "./notifications/notification.service";
import { SmtpService } from "./notifications/smtp.service";
import { PoliciesController } from "./policies/policies.controller";
import { PolicyService } from "./policies/policy.service";
import { TrashController } from "./trash/trash.controller";
import { TrashService } from "./trash/trash.service";
import { SharedContentController } from "./shares/shared-content.controller";
import { SharesController } from "./shares/shares.controller";
import { SharesService } from "./shares/shares.service";

@Module({
  controllers: [
    HealthController, AuthController, FilesController, FoldersController, SharesController, SharedContentController, AuditController,
    PoliciesController, TrashController,
  ],
  providers: [DatabaseService, AuthService, OidcService, FilesService, FoldersService, SharesService, AuditService, SmtpService, NotificationService,
    PolicyService, TrashService,
  ],
})
export class AppModule {}
