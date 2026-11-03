import { and, desc, eq } from "drizzle-orm";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { orders, type ProductVariant } from "../db/schema.js";
import type { Product } from "../products/service.js";

export type Order = typeof orders.$inferSelect;

export const OrderPatch = z.object({
  customerName: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().min(6).max(30).optional(),
  city: z.string().trim().min(2).max(120).optional(),
  address: z.string().trim().max(300).optional(),
  productId: z.string().uuid().optional(),
  options: z.record(z.string(), z.string()).optional(),
  quantity: z.number().int().min(1).max(100).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type OrderPatch = z.infer<typeof OrderPatch>;

export type RequiredField = "customerName" | "phone" | "city";

export function normalizePhone(raw: string, country: string): string | undefined {
  const parsed = parsePhoneNumberFromString(raw, country.toUpperCase() as CountryCode);
  return parsed?.isValid() ? parsed.number : undefined;
}

/** Fields still missing before the order can be submitted, incl. product variant choices. */
export function missingFields(order: Order, product: Product | undefined, required: RequiredField[]): string[] {
  const missing: string[] = required.filter((f) => !order[f]);
  if (!product) missing.push("product");
  for (const v of (product?.variants ?? []) as ProductVariant[]) {
    if (!order.options[v.name]) missing.push(`option:${v.name} (${v.options.join("/")})`);
  }
  return missing;
}

export class OrderService {
  constructor(private readonly db: Db) {}

  async draft(conversationId: string): Promise<Order | undefined> {
    return this.db.query.orders.findFirst({
      where: and(eq(orders.conversationId, conversationId), eq(orders.status, "draft")),
      orderBy: desc(orders.createdAt),
    });
  }

  /**
   * Merges client-provided details into the conversation's draft order.
   * Returns validation problems instead of throwing so the AI can ask again.
   */
  async upsertDraft(
    conversationId: string,
    patch: OrderPatch,
    opts: { phoneCountry: string; product?: Product },
  ): Promise<{ order: Order; problems: string[] }> {
    const problems: string[] = [];
    const data: Partial<typeof orders.$inferInsert> = {};
    if (patch.customerName) data.customerName = patch.customerName;
    if (patch.city) data.city = patch.city;
    if (patch.address) data.address = patch.address;
    if (patch.quantity) data.quantity = patch.quantity;
    if (patch.notes) data.notes = patch.notes;
    if (patch.productId ?? opts.product?.id) data.productId = patch.productId ?? opts.product?.id;
    if (patch.phone) {
      const phone = normalizePhone(patch.phone, opts.phoneCountry);
      if (phone) data.phone = phone;
      else problems.push(`Numéro de téléphone invalide: "${patch.phone}"`);
    }

    const existing = await this.draft(conversationId);
    if (patch.options) {
      const variants = (opts.product?.variants ?? []) as ProductVariant[];
      const merged = { ...(existing?.options ?? {}) };
      for (const [name, value] of Object.entries(patch.options)) {
        const variant = variants.find((v) => v.name.toLowerCase() === name.toLowerCase());
        const option = variant?.options.find((o) => o.toLowerCase() === value.toLowerCase());
        if (variant && !option) problems.push(`Option "${value}" indisponible pour ${variant.name} (choix: ${variant.options.join(", ")})`);
        else merged[variant?.name ?? name] = option ?? value;
      }
      data.options = merged;
    }

    if (existing) {
      const [order] = await this.db.update(orders).set(data).where(eq(orders.id, existing.id)).returning();
      return { order: order!, problems };
    }
    const [order] = await this.db.insert(orders).values({ conversationId, ...data }).returning();
    return { order: order!, problems };
  }

  async markSubmitted(id: string): Promise<Order> {
    const [order] = await this.db.update(orders).set({ status: "submitted", submittedAt: new Date() }).where(eq(orders.id, id)).returning();
    return order!;
  }

  async markSynced(id: string, sheetTab: string): Promise<void> {
    await this.db.update(orders).set({ status: "synced", sheetTab, syncError: null }).where(eq(orders.id, id));
  }

  async markSyncFailed(id: string, error: string): Promise<void> {
    await this.db.update(orders).set({ status: "sync_failed", syncError: error }).where(eq(orders.id, id));
  }

  async get(id: string): Promise<Order | undefined> {
    return this.db.query.orders.findFirst({ where: eq(orders.id, id) });
  }
}
