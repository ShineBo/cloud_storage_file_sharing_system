import { Module } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { NotificationWorkerService } from "./notifications/notification-worker.service";
import { SmtpService } from "./notifications/smtp.service";

@Module({ providers: [DatabaseService, SmtpService, NotificationWorkerService] })
export class NotificationWorkerModule {}
