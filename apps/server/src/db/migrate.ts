import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { createDb, runMigrations } from "./client.js";

const db = createDb(env().DATABASE_URL);
await runMigrations(db);
logger.info("Migrations applied");
await db.$client.end();
