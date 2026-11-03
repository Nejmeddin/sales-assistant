import { Hono } from "hono";
import type { Deps } from "../app/deps.js";
import { ingestEvents } from "../channels/meta/ingest.js";
import { pageIdForInstagram } from "../channels/meta/pages.js";
import { parseWebhook } from "../channels/meta/parser.js";
import { verifyMetaSignature } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

/** Meta webhook (Messenger + Instagram) — one callback URL for both: /webhooks/meta */
export function webhookRoutes(deps: Deps) {
  const app = new Hono();

  // Subscription handshake done by the Meta developer console.
  app.get("/", async (c) => {
    const meta = await deps.settings.get("meta");
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    if (mode === "subscribe" && meta.verifyToken && token === meta.verifyToken) {
      return c.text(c.req.query("hub.challenge") ?? "");
    }
    return c.text("Forbidden", 403);
  });

  app.post("/", async (c) => {
    const raw = await c.req.text();
    const meta = await deps.settings.get("meta");
    if (!meta.appSecret || !verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), meta.appSecret)) {
      logger.warn("Rejected webhook: invalid or missing signature (is the App Secret configured?)");
      return c.text("Invalid signature", 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("Bad request", 400);
    }
    const events = parseWebhook(body, (igId) => pageIdForInstagram(meta, igId));
    try {
      await ingestEvents(deps, events);
    } catch (err) {
      // Non-2xx makes Meta redeliver; ingestion is idempotent (unique message ids).
      logger.error({ err }, "Webhook ingestion failed");
      return c.text("Error", 500);
    }
    return c.text("EVENT_RECEIVED");
  });

  return app;
}
