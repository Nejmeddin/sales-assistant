import { serve } from "@hono/node-server";
import { Auth } from "./api/auth.js";
import { createDeps } from "./app/deps.js";
import { createHttpApp } from "./app/http.js";
import { registerJobs } from "./app/jobs.js";
import { createDb, runMigrations } from "./db/client.js";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";

const config = env();
const db = createDb(config.DATABASE_URL);
await runMigrations(db);

const deps = createDeps(db, { encryptionKey: config.ENCRYPTION_KEY, publicUrl: config.PUBLIC_URL });
const auth = new Auth(db, config.SESSION_SECRET, config.PUBLIC_URL.startsWith("https://"));
await auth.ensureAdmin(config.ADMIN_EMAIL, config.ADMIN_PASSWORD);

registerJobs(deps);
if (config.RUN_WORKER) {
  deps.queue.start();
  setInterval(() => void deps.queue.prune().catch(() => undefined), 6 * 3_600_000).unref();
}

const server = serve({ fetch: createHttpApp(deps, auth).fetch, port: config.PORT }, (info) => {
  logger.info(`Server listening on :${info.port} — webhook: ${deps.publicUrl}/webhooks/meta`);
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, "Shutting down");
  server.close();
  await deps.queue.stop();
  await db.$client.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
