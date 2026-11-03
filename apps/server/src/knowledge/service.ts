import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { knowledge } from "../db/schema.js";

export type KnowledgeEntry = typeof knowledge.$inferSelect;

export class KnowledgeService {
  constructor(private readonly db: Db) {}

  async add(entry: { question: string; answer: string; productId?: string | null; source?: "manual" | "escalation"; escalationId?: string }): Promise<KnowledgeEntry> {
    const [row] = await this.db
      .insert(knowledge)
      .values({ ...entry, productId: entry.productId ?? null, source: entry.source ?? "manual" })
      .returning();
    return row!;
  }

  /**
   * French full-text search with OR semantics (recall matters more than precision here: the
   * model judges relevance). Product-specific answers rank above general ones.
   */
  async search(query: string, opts: { productId?: string | null; limit?: number } = {}): Promise<Pick<KnowledgeEntry, "id" | "question" | "answer" | "productId">[]> {
    const words = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 12);
    if (words.length === 0) return [];
    const tsquery = sql`to_tsquery('french', ${words.join(" | ")})`;
    const productFilter = opts.productId ? or(isNull(knowledge.productId), eq(knowledge.productId, opts.productId)) : isNull(knowledge.productId);
    return this.db
      .select({ id: knowledge.id, question: knowledge.question, answer: knowledge.answer, productId: knowledge.productId })
      .from(knowledge)
      .where(and(eq(knowledge.enabled, true), productFilter, sql`${knowledge.search} @@ ${tsquery}`))
      .orderBy(
        desc(sql`ts_rank(${knowledge.search}, ${tsquery}) + CASE WHEN ${knowledge.productId} IS NOT NULL THEN 0.5 ELSE 0 END`),
      )
      .limit(opts.limit ?? 5);
  }

  async list(): Promise<KnowledgeEntry[]> {
    return this.db.query.knowledge.findMany({ orderBy: desc(knowledge.createdAt) });
  }

  async update(id: string, patch: Partial<Pick<KnowledgeEntry, "question" | "answer" | "enabled" | "productId">>): Promise<KnowledgeEntry | undefined> {
    const [row] = await this.db.update(knowledge).set(patch).where(eq(knowledge.id, id)).returning();
    return row;
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(knowledge).where(eq(knowledge.id, id));
  }
}
