import "reflect-metadata";
import multipart from "@fastify/multipart";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { DatabaseService } from "./database.service";

async function bootstrap() {
  const host = process.env.API_HOST ?? "127.0.0.1";
  const port = Number(process.env.API_PORT ?? 3001);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("API_PORT must be an integer between 1 and 65535.");
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ multipart: false, requestTimeout: 3_600_000 }),
  );
  try {
    await app.get(DatabaseService).assertServingState();
  } catch (error) {
    await app.close();
    throw error;
  }
  await app.register(multipart);
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  await app.listen(port, host);
}

void bootstrap();
