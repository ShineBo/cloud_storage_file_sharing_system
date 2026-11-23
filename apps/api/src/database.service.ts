import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool?: Pool;
  private readonly logger = new Logger(DatabaseService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL?.trim();

    if (connectionString || process.env.PGHOST) {
      this.pool = new Pool({
        connectionString,
        max: 10,
        connectionTimeoutMillis: 1_000,
        query_timeout: 6_000,
        statement_timeout: 5_000,
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

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) {
      throw new ServiceUnavailableException("Database is unavailable.");
    }

    const client = await this.pool.connect();
    let discardConnection = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discardConnection = true;
      }
      throw error;
    } finally {
      client.release(discardConnection);
    }
  }

  async isReady() {
    if (!this.pool) {
      return false;
    }

    try {
      const result = await this.pool.query("SELECT 1 FROM recovery_state WHERE singleton AND NOT blocked");
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }

  async assertServingState() {
    if (this.pool && !(await this.isReady())) {
      throw new Error("The database is unavailable or awaiting recovery review.");
    }
  }

  async onApplicationShutdown() {
    await this.pool?.end();
  }
}
