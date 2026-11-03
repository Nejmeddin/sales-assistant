import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Auth } from "../api/auth.js";
import { apiRoutes } from "../api/routes.js";
import { webhookRoutes } from "../api/webhook.js";
import type { Deps } from "./deps.js";

export function createHttpApp(deps: Deps, auth: Auth) {
  const app = new Hono();
  app.use("*", secureHeaders());

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/webhooks/meta", webhookRoutes(deps));
  app.route("/api", apiRoutes(deps, auth));

  // Dashboard SPA (apps/dashboard build output), served by the same process.
  const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dashboard/dist");
  if (existsSync(dashboardDir)) {
    const root = path.relative(process.cwd(), dashboardDir);
    app.use("/assets/*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  }
  return app;
}
