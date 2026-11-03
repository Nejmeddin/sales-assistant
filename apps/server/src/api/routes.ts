import { and, count, desc, eq, gte, sql, sum } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Deps } from "../app/deps.js";
import { GeminiProvider } from "../agent/providers/gemini.js";
import { pageCredentials } from "../channels/meta/pages.js";
import { agentRuns, contacts, conversations, escalations, messages, orders, products } from "../db/schema.js";
import { EscalationService } from "../escalation/service.js";
import { GoogleSheetsWriter } from "../integrations/sheets.js";
import { draftFromPost } from "../products/import.js";
import { ProductInput } from "../products/service.js";
import { SettingsSchema, type SettingsKey } from "../settings/schema.js";
import type { Auth, AuthVariables } from "./auth.js";

class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const json = await c.req.json().catch(() => {
    throw new HttpError(400, "Invalid JSON body");
  });
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new HttpError(422, z.prettifyError(parsed.error));
  return parsed.data;
}

const isSettingsKey = (k: string): k is SettingsKey => k in SettingsSchema;

export function apiRoutes(deps: Deps, auth: Auth) {
  const app = new Hono<{ Variables: AuthVariables }>();
  const escalationService = new EscalationService(deps);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    return c.json({ error: err.message || "Internal error" }, 500);
  });

  // ── Auth ────────────────────────────────────────────────────────────────────
  app.post("/auth/login", async (c) => {
    const { email, password } = await body(c, z.object({ email: z.string().email(), password: z.string().min(1) }));
    const user = await auth.login(c, email, password);
    return user ? c.json({ user }) : c.json({ error: "Identifiants invalides" }, 401);
  });
  app.post("/auth/logout", (c) => {
    auth.logout(c);
    return c.json({ ok: true });
  });

  app.use("*", auth.middleware());
  app.get("/auth/me", (c) => c.json({ user: c.get("user") }));

  // ── Settings ────────────────────────────────────────────────────────────────
  app.get("/settings", async (c) => {
    const keys = Object.keys(SettingsSchema) as SettingsKey[];
    const entries = await Promise.all(keys.map(async (k) => [k, await deps.settings.getPublic(k)] as const));
    return c.json({ settings: Object.fromEntries(entries), webhookUrl: `${deps.publicUrl}/webhooks/meta` });
  });

  app.put("/settings/:key", async (c) => {
    const key = c.req.param("key");
    if (!isSettingsKey(key)) throw new HttpError(404, "Unknown settings section");
    const input = await c.req.json();
    const parsed = SettingsSchema[key].safeParse(input);
    if (!parsed.success) throw new HttpError(422, z.prettifyError(parsed.error));
    await deps.settings.set(key, parsed.data);
    return c.json({ settings: await deps.settings.getPublic(key) });
  });

  /** "Test connection" buttons. */
  app.post("/settings/test/:target", async (c) => {
    const target = c.req.param("target");
    try {
      switch (target) {
        case "ai": {
          const ai = await deps.settings.get("ai");
          const provider = deps.createProvider(ai);
          const reply = await provider.runAgent({
            system: "Réponds en un mot.",
            messages: [{ role: "user", parts: [{ type: "text", text: "Dis bonjour." }] }],
            tools: [],
            executeTool: async () => null,
            maxSteps: 1,
          });
          const models = ai.provider === "gemini" ? await new GeminiProvider(ai.gemini.apiKey, ai.gemini.model).listModels().catch(() => []) : [];
          return c.json({ ok: true, detail: `${provider.name}/${provider.model}: « ${reply.text} »`, models });
        }
        case "meta": {
          const meta = await deps.settings.get("meta");
          const results = await Promise.all(
            meta.pages.map(async (p) => {
              try {
                const info = await deps.meta(meta.graphVersion).checkPage(pageCredentials(meta, p.pageId));
                return { pageId: p.pageId, ok: true, name: info.name };
              } catch (err) {
                return { pageId: p.pageId, ok: false, error: (err as Error).message };
              }
            }),
          );
          return c.json({ ok: results.every((r) => r.ok), pages: results });
        }
        case "sheets": {
          const s = await deps.settings.get("sheets");
          const info = await new GoogleSheetsWriter(s.spreadsheetId, s.serviceAccountJson).check();
          return c.json({ ok: true, detail: `Feuille « ${info.title} » accessible` });
        }
        case "email": {
          const n = await deps.settings.get("notifications");
          const mailer = deps.createMailer(n);
          if (!mailer || n.escalationEmails.length === 0) throw new Error("Transport ou destinataires non configurés");
          await mailer.send({ to: n.escalationEmails, subject: "Test — assistant commercial", text: "La configuration e-mail fonctionne ✅", html: "<p>La configuration e-mail fonctionne ✅</p>" });
          return c.json({ ok: true, detail: `E-mail envoyé à ${n.escalationEmails.join(", ")}` });
        }
        default:
          throw new HttpError(404, "Unknown test target");
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return c.json({ ok: false, error: (err as Error).message });
    }
  });

  // ── Products ────────────────────────────────────────────────────────────────
  app.get("/products", async (c) => c.json({ products: await deps.products.list() }));
  app.post("/products", async (c) => c.json({ product: await deps.products.create(await body(c, ProductInput)) }, 201));
  app.patch("/products/:id", async (c) => {
    const product = await deps.products.update(c.req.param("id"), await body(c, ProductInput.partial()));
    if (!product) throw new HttpError(404, "Product not found");
    return c.json({ product });
  });
  app.delete("/products/:id", async (c) => {
    await deps.products.remove(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** Lists recent page posts with an AI-extracted product draft for each (owner confirms). */
  app.post("/products/import-posts", async (c) => {
    const { pageId, limit } = await body(c, z.object({ pageId: z.string(), limit: z.number().int().min(1).max(25).default(10) }));
    const [meta, ai, bot] = await Promise.all([deps.settings.get("meta"), deps.settings.get("ai"), deps.settings.get("bot")]);
    const posts = await deps.meta(meta.graphVersion).listPagePosts(pageCredentials(meta, pageId), limit);
    const known = new Set((await deps.products.list()).flatMap((p) => p.fbPostIds));
    const provider = deps.createProvider(ai);
    const drafts = [];
    for (const post of posts.filter((p) => p.message && !known.has(p.id))) {
      drafts.push(await draftFromPost(provider, post, bot.currency).catch((err: Error) => ({ error: err.message, fbPostIds: [post.id] })));
    }
    return c.json({ drafts });
  });

  // ── Conversations ───────────────────────────────────────────────────────────
  app.get("/conversations", async (c) => {
    const status = c.req.query("status") as "active" | "escalated" | "closed" | undefined;
    const lastMessage = deps.db
      .select({ conversationId: messages.conversationId, text: messages.text, createdAt: messages.createdAt, author: messages.author })
      .from(messages)
      .where(sql`${messages.id} = (SELECT m.id FROM messages m WHERE m.conversation_id = ${conversations.id} ORDER BY m.created_at DESC LIMIT 1)`)
      .as("last_message");
    const rows = await deps.db
      .select({ conversation: conversations, contact: contacts, lastMessage: { text: lastMessage.text, createdAt: lastMessage.createdAt, author: lastMessage.author } })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .leftJoinLateral(lastMessage, sql`true`)
      .where(status ? eq(conversations.status, status) : undefined)
      .orderBy(desc(sql`coalesce(${conversations.lastInboundAt}, ${conversations.createdAt})`))
      .limit(100);
    return c.json({ conversations: rows });
  });

  app.get("/conversations/:id", async (c) => {
    const found = await deps.conversations.getWithContact(c.req.param("id"));
    if (!found) throw new HttpError(404, "Conversation not found");
    const id = found.conversation.id;
    const [history, convOrders, convEscalations] = await Promise.all([
      deps.conversations.history(id, 200),
      deps.db.query.orders.findMany({ where: eq(orders.conversationId, id), orderBy: desc(orders.createdAt) }),
      deps.db.query.escalations.findMany({ where: eq(escalations.conversationId, id), orderBy: desc(escalations.createdAt) }),
    ]);
    return c.json({ ...found, messages: history, orders: convOrders, escalations: convEscalations });
  });

  app.post("/conversations/:id/pause", async (c) => {
    const { minutes } = await body(c, z.object({ minutes: z.number().int().min(0).max(525_600) }));
    await deps.conversations.update(c.req.param("id"), { botPausedUntil: minutes ? new Date(Date.now() + minutes * 60_000) : null });
    return c.json({ ok: true });
  });

  // ── Escalations ─────────────────────────────────────────────────────────────
  app.get("/escalations", async (c) => {
    const status = c.req.query("status") as "open" | "answered" | "dismissed" | undefined;
    const rows = await deps.db
      .select({ escalation: escalations, contact: contacts, productName: products.name, lastInboundAt: conversations.lastInboundAt })
      .from(escalations)
      .innerJoin(conversations, eq(conversations.id, escalations.conversationId))
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .leftJoin(products, eq(products.id, escalations.productId))
      .where(status ? eq(escalations.status, status) : undefined)
      .orderBy(desc(escalations.createdAt))
      .limit(200);
    return c.json({ escalations: rows });
  });
  app.get("/escalations/:id", async (c) => {
    const escalation = await escalationService.get(c.req.param("id"));
    if (!escalation) throw new HttpError(404, "Escalation not found");
    const found = await deps.conversations.getWithContact(escalation.conversationId);
    const product = escalation.productId ? await deps.products.get(escalation.productId) : undefined;
    const history = await deps.conversations.history(escalation.conversationId, 30);
    return c.json({ escalation, ...found, product: product ?? null, messages: history });
  });
  app.post("/escalations/:id/answer", async (c) => {
    const input = await body(
      c,
      z.object({
        answer: z.string().trim().min(1).max(2000),
        saveAsKnowledge: z.boolean().default(true),
        knowledgeQuestion: z.string().optional(),
        productSpecific: z.boolean().optional(),
      }),
    );
    try {
      const escalation = await escalationService.answer(c.req.param("id"), { ...input, userId: c.get("user").id });
      return c.json({ escalation });
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  });
  app.post("/escalations/:id/dismiss", async (c) => {
    await escalationService.dismiss(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── Orders ──────────────────────────────────────────────────────────────────
  app.get("/orders", async (c) => {
    const status = c.req.query("status") as (typeof orders.$inferSelect)["status"] | undefined;
    const rows = await deps.db
      .select({ order: orders, productName: products.name, price: products.price, currency: products.currency, channel: contacts.channel })
      .from(orders)
      .innerJoin(conversations, eq(conversations.id, orders.conversationId))
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .leftJoin(products, eq(products.id, orders.productId))
      .where(status ? eq(orders.status, status) : sql`${orders.status} <> 'draft'`)
      .orderBy(desc(orders.createdAt))
      .limit(500);
    return c.json({ orders: rows });
  });
  app.post("/orders/:id/resync", async (c) => {
    await deps.queue.enqueue("order.sheet", c.req.param("id"), { orderId: c.req.param("id") });
    return c.json({ ok: true });
  });

  // ── Knowledge ───────────────────────────────────────────────────────────────
  const KnowledgeInput = z.object({
    question: z.string().trim().min(3),
    answer: z.string().trim().min(1),
    productId: z.string().uuid().nullable().default(null),
    enabled: z.boolean().default(true),
  });
  app.get("/knowledge", async (c) => c.json({ knowledge: await deps.knowledge.list() }));
  app.post("/knowledge", async (c) => {
    const { enabled: _enabled, ...input } = await body(c, KnowledgeInput);
    return c.json({ entry: await deps.knowledge.add(input) }, 201);
  });
  app.patch("/knowledge/:id", async (c) => {
    const entry = await deps.knowledge.update(c.req.param("id"), await body(c, KnowledgeInput.partial()));
    if (!entry) throw new HttpError(404, "Entry not found");
    return c.json({ entry });
  });
  app.delete("/knowledge/:id", async (c) => {
    await deps.knowledge.remove(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── Overview ────────────────────────────────────────────────────────────────
  app.get("/stats", async (c) => {
    const days = Number(c.req.query("days") ?? 7);
    const since = new Date(Date.now() - days * 86_400_000);
    const [inbound] = await deps.db.select({ n: count() }).from(messages).where(and(eq(messages.direction, "in"), gte(messages.createdAt, since)));
    const runs = await deps.db
      .select({ outcome: agentRuns.outcome, n: count(), input: sum(agentRuns.inputTokens), output: sum(agentRuns.outputTokens), latency: sql<number>`avg(${agentRuns.latencyMs})` })
      .from(agentRuns)
      .where(gte(agentRuns.createdAt, since))
      .groupBy(agentRuns.outcome);
    const [submitted] = await deps.db.select({ n: count() }).from(orders).where(and(sql`${orders.status} <> 'draft'`, gte(orders.createdAt, since)));
    const [openEsc] = await deps.db.select({ n: count() }).from(escalations).where(eq(escalations.status, "open"));
    const [convs] = await deps.db.select({ n: count() }).from(conversations).where(gte(conversations.createdAt, since));
    const perDay = await deps.db.execute<{ day: string; messages: number; orders: number }>(sql`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
        (SELECT count(*)::int FROM messages m WHERE m.direction = 'in' AND m.created_at >= d AND m.created_at < d + interval '1 day') AS messages,
        (SELECT count(*)::int FROM orders o WHERE o.status <> 'draft' AND o.submitted_at >= d AND o.submitted_at < d + interval '1 day') AS orders
      FROM generate_series(date_trunc('day', now()) - (${days - 1} * interval '1 day'), date_trunc('day', now()), interval '1 day') d`);
    return c.json({
      days,
      inboundMessages: inbound?.n ?? 0,
      newConversations: convs?.n ?? 0,
      runs,
      orders: submitted?.n ?? 0,
      openEscalations: openEsc?.n ?? 0,
      perDay: perDay.rows,
    });
  });

  return app;
}
