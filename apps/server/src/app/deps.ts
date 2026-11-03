import type { Db } from "../db/client.js";
import { MetaClient, type FetchLike } from "../channels/meta/client.js";
import { ConversationService } from "../conversation/service.js";
import { KnowledgeService } from "../knowledge/service.js";
import { OrderService } from "../orders/service.js";
import { ProductService } from "../products/service.js";
import { JobQueue } from "../queue/queue.js";
import { SettingsService } from "../settings/service.js";
import { createProvider, type ProviderFactory } from "../agent/providers/index.js";
import { createMailer, type MailerFactory } from "../notify/mailer.js";
import { createSheetsWriter, type SheetsFactory } from "../integrations/sheets.js";

/** Composition root. Factories are injectable so tests can replace external services. */
export type Deps = {
  db: Db;
  publicUrl: string;
  settings: SettingsService;
  queue: JobQueue;
  products: ProductService;
  conversations: ConversationService;
  orders: OrderService;
  knowledge: KnowledgeService;
  createProvider: ProviderFactory;
  createMailer: MailerFactory;
  createSheets: SheetsFactory;
  meta: (graphVersion: string) => MetaClient;
  fetch: FetchLike;
};

export function createDeps(
  db: Db,
  cfg: { encryptionKey: string; publicUrl: string },
  overrides: Partial<Pick<Deps, "createProvider" | "createMailer" | "createSheets" | "fetch">> = {},
): Deps {
  const fetchImpl = overrides.fetch ?? fetch;
  return {
    db,
    publicUrl: cfg.publicUrl.replace(/\/$/, ""),
    settings: new SettingsService(db, cfg.encryptionKey),
    queue: new JobQueue(db),
    products: new ProductService(db),
    conversations: new ConversationService(db),
    orders: new OrderService(db),
    knowledge: new KnowledgeService(db),
    createProvider: overrides.createProvider ?? createProvider,
    createMailer: overrides.createMailer ?? createMailer,
    createSheets: overrides.createSheets ?? createSheetsWriter,
    meta: (graphVersion) => new MetaClient(graphVersion, fetchImpl),
    fetch: fetchImpl,
  };
}
