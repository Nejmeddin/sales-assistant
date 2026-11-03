import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { products, type ProductVariant } from "../db/schema.js";

export type Product = typeof products.$inferSelect;

export const ProductInput = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  price: z.number().nonnegative().nullable().default(null),
  currency: z.string().default("TND"),
  variants: z.array(z.object({ name: z.string().min(1), options: z.array(z.string().min(1)).min(1) })).default([]),
  inStock: z.boolean().nullable().default(null),
  active: z.boolean().default(true),
  images: z.array(z.string().url()).default([]),
  keywords: z.array(z.string()).default([]),
  fbPostIds: z.array(z.string()).default([]),
  adIds: z.array(z.string()).default([]),
  igMediaIds: z.array(z.string()).default([]),
  storeUrl: z.string().url().nullable().default(null),
  sourceUrl: z.string().url().nullable().default(null),
});
export type ProductInput = z.infer<typeof ProductInput>;

/** Business rule: an unfilled stock field means the product is available. */
export const isAvailable = (p: Pick<Product, "inStock">): boolean => p.inStock !== false;

/** Facebook post ids come as `{pageId}_{postId}` or bare `{postId}` depending on the API surface. */
function postIdVariants(postId: string): string[] {
  const bare = postId.includes("_") ? postId.split("_").pop()! : postId;
  return [...new Set([postId, bare])];
}

export class ProductService {
  constructor(private readonly db: Db) {}

  async create(input: ProductInput): Promise<Product> {
    const data = ProductInput.parse(input);
    const [row] = await this.db
      .insert(products)
      .values({ ...data, sourceStatus: data.sourceUrl ? "linked" : "none" })
      .returning();
    return row!;
  }

  async update(id: string, input: Partial<ProductInput>): Promise<Product | undefined> {
    const data = ProductInput.partial().parse(input);
    const patch: Partial<typeof products.$inferInsert> = { ...data };
    if (data.sourceUrl !== undefined) patch.sourceStatus = data.sourceUrl ? "linked" : "none";
    const [row] = await this.db.update(products).set(patch).where(eq(products.id, id)).returning();
    return row;
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(products).where(eq(products.id, id));
  }

  async get(id: string): Promise<Product | undefined> {
    if (!z.string().uuid().safeParse(id).success) return undefined;
    return this.db.query.products.findFirst({ where: eq(products.id, id) });
  }

  async list(opts: { activeOnly?: boolean } = {}): Promise<Product[]> {
    return this.db.query.products.findMany({
      where: opts.activeOnly ? eq(products.active, true) : undefined,
      orderBy: desc(products.createdAt),
    });
  }

  /** Resolves the product a client is asking about from an ad click / post referral. */
  async findByReferral(ref: { postId?: string; adId?: string }): Promise<Product | undefined> {
    const conditions: SQL[] = [];
    if (ref.adId) conditions.push(sql`${ref.adId} = ANY(${products.adIds})`);
    if (ref.postId) {
      for (const v of postIdVariants(ref.postId)) {
        conditions.push(sql`(${v} = ANY(${products.fbPostIds}) OR EXISTS (SELECT 1 FROM unnest(${products.fbPostIds}) p WHERE p LIKE '%\\_' || ${v}))`);
      }
    }
    if (conditions.length === 0) return undefined;
    return this.db.query.products.findFirst({ where: and(eq(products.active, true), sql`(${sql.join(conditions, sql` OR `)})`) });
  }

  /** Resolves a shared post / Instagram media attachment. */
  async findByAttachment(att: { url?: string; mediaId?: string }): Promise<Product | undefined> {
    if (att.mediaId) {
      const hit = await this.db.query.products.findFirst({ where: sql`${att.mediaId} = ANY(${products.igMediaIds})` });
      if (hit) return hit;
    }
    // Facebook post URLs contain the numeric post id (…/posts/123, story_fbid=123, /permalink/123).
    const match = att.url?.match(/(?:posts\/|story_fbid=|permalink\/|fbid=)(\d{6,})/);
    return match?.[1] ? this.findByReferral({ postId: match[1] }) : undefined;
  }

  /** Free-text search over name, keywords and description (accent-insensitive). */
  async search(query: string, limit = 5): Promise<Product[]> {
    const words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    if (words.length === 0) return [];
    const haystack = sql`lower(${products.name} || ' ' || array_to_string(${products.keywords}, ' ') || ' ' || ${products.description})`;
    const score = sql.join(
      words.map((w) => sql`(CASE WHEN ${haystack} LIKE ${"%" + w + "%"} THEN 1 ELSE 0 END)`),
      sql` + `,
    );
    return this.db
      .select()
      .from(products)
      .where(and(eq(products.active, true), sql`(${score}) > 0`))
      .orderBy(sql`(${score}) DESC`, desc(products.createdAt))
      .limit(limit);
  }

  /** Compact line used in the system prompt catalog. */
  static summary(p: Product): string {
    const price = p.price != null ? `${p.price} ${p.currency}` : "prix: voir publication";
    const variants = (p.variants as ProductVariant[]).map((v) => `${v.name}: ${v.options.join("/")}`).join("; ");
    return `- [${p.id}] ${p.name} — ${price} — ${isAvailable(p) ? "disponible" : "RUPTURE DE STOCK"}${variants ? ` — ${variants}` : ""}`;
  }
}
