import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    // Neon / Supabase require TLS; local docker does not.
    ssl: /sslmode=require|neon\.tech|supabase\.co/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
  });
  return drizzle(pool, { schema, casing: "snake_case" }) as Db;
}

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}

export { schema };
