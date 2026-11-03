import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ─── Enums ────────────────────────────────────────────────────────────────────
export const channelEnum = pgEnum("channel", ["messenger", "instagram"]);
export const conversationStatusEnum = pgEnum("conversation_status", ["active", "escalated", "closed"]);
export const conversationStageEnum = pgEnum("conversation_stage", ["answering", "collecting_order", "ordered"]);
export const directionEnum = pgEnum("message_direction", ["in", "out"]);
export const authorEnum = pgEnum("message_author", ["client", "bot", "human"]);
export const orderStatusEnum = pgEnum("order_status", ["draft", "submitted", "synced", "sync_failed"]);
export const escalationStatusEnum = pgEnum("escalation_status", ["open", "answered", "dismissed"]);
export const knowledgeSourceEnum = pgEnum("knowledge_source", ["manual", "escalation"]);
export const sourceStatusEnum = pgEnum("source_status", ["none", "linked", "searching", "matched", "not_found"]);
export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "done", "failed"]);

// ─── Auth & settings ──────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "agent"] }).notNull().default("admin"),
  createdAt: createdAt(),
});

/** One row per settings section (ai, bot, meta, notifications, sheets, sources). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

// ─── Catalog ──────────────────────────────────────────────────────────────────
export type ProductVariant = { name: string; options: string[] };
export type SourceCandidate = { url: string; title: string; site: string; thumbnail?: string; score?: number };

export const products = pgTable(
  "products",
  {
    id: id(),
    name: text("name").notNull(),
    /** Text of the Facebook post / ad: the primary truth for details and policies. */
    description: text("description").notNull().default(""),
    price: numeric("price", { precision: 12, scale: 3, mode: "number" }),
    currency: text("currency").notNull().default("TND"),
    variants: jsonb("variants").$type<ProductVariant[]>().notNull().default([]),
    /** null ⇒ "not filled" ⇒ treated as available (business rule). */
    inStock: boolean("in_stock"),
    active: boolean("active").notNull().default(true),
    images: text("images").array().notNull().default(sql`'{}'::text[]`),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    /** Facebook post ids (`{pageId}_{postId}`), ad ids and Instagram media ids that advertise this product. */
    fbPostIds: text("fb_post_ids").array().notNull().default(sql`'{}'::text[]`),
    adIds: text("ad_ids").array().notNull().default(sql`'{}'::text[]`),
    igMediaIds: text("ig_media_ids").array().notNull().default(sql`'{}'::text[]`),
    storeUrl: text("store_url"),
    /** AliExpress / Alibaba page used to enrich answers. */
    sourceUrl: text("source_url"),
    sourceStatus: sourceStatusEnum("source_status").notNull().default("none"),
    sourceCandidates: jsonb("source_candidates").$type<SourceCandidate[]>().notNull().default([]),
    /** Specs extracted from the source page (materials, dimensions, FAQ…), as concise text. */
    sourceSpecs: text("source_specs"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("products_fb_posts_idx").using("gin", t.fbPostIds),
    index("products_ad_ids_idx").using("gin", t.adIds),
    index("products_ig_media_idx").using("gin", t.igMediaIds),
  ],
);

// ─── Conversations ────────────────────────────────────────────────────────────
export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    channel: channelEnum("channel").notNull(),
    /** Facebook page id (also for Instagram: the page the IG account is linked to). */
    pageId: text("page_id").notNull(),
    /** PSID (Messenger) or IGSID (Instagram). */
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("contacts_identity_uq").on(t.channel, t.pageId, t.externalId)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" })
      .unique(),
    status: conversationStatusEnum("status").notNull().default("active"),
    stage: conversationStageEnum("stage").notNull().default("answering"),
    currentProductId: uuid("current_product_id").references(() => products.id, { onDelete: "set null" }),
    /** Set when a human answers from Meta Business Suite: the bot stays quiet until then. */
    botPausedUntil: timestamp("bot_paused_until", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("conversations_last_inbound_idx").on(t.lastInboundAt)],
);

export type Attachment = { type: string; url?: string; title?: string; mediaId?: string };
export type Referral = { source?: string; adId?: string; postId?: string; ref?: string; adTitle?: string; photoUrl?: string };

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: directionEnum("direction").notNull(),
    author: authorEnum("author").notNull(),
    /** Meta message id — unique, makes webhook redeliveries idempotent. */
    mid: text("mid").unique(),
    text: text("text").notNull().default(""),
    attachments: jsonb("attachments").$type<Attachment[]>().notNull().default([]),
    referral: jsonb("referral").$type<Referral>(),
    /** Inbound only: set once the bot has taken the message into account. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

// ─── Orders (leads) ───────────────────────────────────────────────────────────
export const orders = pgTable(
  "orders",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    customerName: text("customer_name"),
    phone: text("phone"),
    city: text("city"),
    address: text("address"),
    options: jsonb("options").$type<Record<string, string>>().notNull().default({}),
    quantity: integer("quantity").notNull().default(1),
    notes: text("notes"),
    status: orderStatusEnum("status").notNull().default("draft"),
    sheetTab: text("sheet_tab"),
    syncError: text("sync_error"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("orders_conversation_idx").on(t.conversationId), index("orders_status_idx").on(t.status)],
);

// ─── Escalations & knowledge ──────────────────────────────────────────────────
export const escalations = pgTable(
  "escalations",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    question: text("question").notNull(),
    reason: text("reason").notNull(),
    status: escalationStatusEnum("status").notNull().default("open"),
    answer: text("answer"),
    answeredBy: uuid("answered_by").references(() => users.id, { onDelete: "set null" }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("escalations_status_idx").on(t.status, t.createdAt)],
);

export const knowledge = pgTable(
  "knowledge",
  {
    id: id(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    source: knowledgeSourceEnum("source").notNull().default("manual"),
    escalationId: uuid("escalation_id").references(() => escalations.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('french', coalesce(question, '') || ' ' || coalesce(answer, ''))`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("knowledge_search_idx").using("gin", t.search)],
);

// ─── Infrastructure ───────────────────────────────────────────────────────────
/** Postgres-backed job queue: no Redis needed (keeps hosting free). */
export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    /** Serialisation key: at most one pending and one running job per (type, key). */
    key: text("key").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: jobStatusEnum("status").notNull().default("pending"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("jobs_pending_key_uq").on(t.type, t.key).where(sql`status = 'pending'`),
    index("jobs_due_idx").on(t.status, t.runAt),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    toolCalls: jsonb("tool_calls").$type<{ name: string; input: unknown; output: unknown }[]>().notNull().default([]),
    latencyMs: integer("latency_ms").notNull().default(0),
    outcome: text("outcome", { enum: ["replied", "escalated", "silent", "error"] }).notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("agent_runs_created_idx").on(t.createdAt)],
);
