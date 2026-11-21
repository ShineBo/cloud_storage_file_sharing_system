import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { Pool, type QueryResultRow } from "pg";

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool?: Pool;
  private readonly logger = new Logger(DatabaseService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL?.trim();

    if (connectionString || process.env.PGHOST) {
      this.pool = new Pool({
        connectionString,
        max: 2,
        connectionTimeoutMillis: 1_000,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      });
      this.pool.on("error", () => {
        this.logger.warn("An idle database connection closed unexpectedly.");
      });
    }
  }

  async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
    if (!this.pool) {
      throw new ServiceUnavailableException("Database is unavailable.");
    }

    return this.pool.query<R>(text, values);
  }

  async isReady() {
    if (!this.pool) {
      return false;
    }

    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async onApplicationShutdown() {
    await this.pool?.end();
  }
}
