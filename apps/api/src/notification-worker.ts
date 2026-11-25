import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NotificationWorkerModule } from "./notification-worker.module";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(NotificationWorkerModule, { abortOnError: false });
  app.enableShutdownHooks();
}

void bootstrap().catch(() => {
  new Logger("NotificationWorker").error("The notification worker could not start.");
  process.exitCode = 1;
});
