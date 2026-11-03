import { desc, eq } from "drizzle-orm";
import type { Deps } from "../app/deps.js";
import { escalations } from "../db/schema.js";
import { MetaApiError } from "../channels/meta/client.js";
import { pageCredentials } from "../channels/meta/pages.js";

export type Escalation = typeof escalations.$inferSelect;

export const JOB_ESCALATION_EMAIL = "email.escalation";

const HOURS_24 = 24 * 3_600_000;
const DAYS_7 = 7 * 24 * 3_600_000;

export class EscalationService {
  constructor(private readonly deps: Deps) {}

  async create(conversationId: string, p: { question: string; reason: string; productId?: string | null }): Promise<Escalation> {
    const [row] = await this.deps.db
      .insert(escalations)
      .values({ conversationId, question: p.question, reason: p.reason, productId: p.productId ?? null })
      .returning();
    await this.deps.conversations.update(conversationId, { status: "escalated" });
    await this.deps.queue.enqueue(JOB_ESCALATION_EMAIL, row!.id, { escalationId: row!.id });
    return row!;
  }

  async get(id: string): Promise<Escalation | undefined> {
    return this.deps.db.query.escalations.findFirst({ where: eq(escalations.id, id) });
  }

  async list(status?: Escalation["status"]): Promise<Escalation[]> {
    return this.deps.db.query.escalations.findMany({
      where: status ? eq(escalations.status, status) : undefined,
      orderBy: desc(escalations.createdAt),
      limit: 200,
    });
  }

  /**
   * Sends the team's answer to the client and (optionally) stores it as knowledge so the
   * assistant can reuse it. Late answers (> 24h) use the HUMAN_AGENT tag (allowed up to 7 days).
   */
  async answer(id: string, p: { answer: string; userId?: string; saveAsKnowledge: boolean; knowledgeQuestion?: string; productSpecific?: boolean }): Promise<Escalation> {
    const escalation = await this.get(id);
    if (!escalation) throw new Error("Escalation not found");
    if (escalation.status !== "open") throw new Error("Escalation already handled");
    const found = await this.deps.conversations.getWithContact(escalation.conversationId);
    if (!found) throw new Error("Conversation not found");
    const { conversation, contact } = found;

    const meta = await this.deps.settings.get("meta");
    const page = pageCredentials(meta, contact.pageId);
    const elapsed = Date.now() - (conversation.lastInboundAt?.getTime() ?? 0);
    if (elapsed > DAYS_7) throw new Error("Le client a écrit il y a plus de 7 jours : Meta n'autorise plus la réponse.");

    let mid: string;
    try {
      mid = await this.deps.meta(meta.graphVersion).sendText(page, contact.externalId, p.answer, elapsed > HOURS_24 ? { tag: "HUMAN_AGENT" } : {});
    } catch (err) {
      if (err instanceof MetaApiError && err.isWindowClosed) {
        throw new Error("Fenêtre de réponse Meta fermée : la permission HUMAN_AGENT est requise pour répondre après 24h.");
      }
      throw err;
    }
    await this.deps.conversations.addOutbound(conversation.id, { mid, text: p.answer, author: "human" });

    const [updated] = await this.deps.db
      .update(escalations)
      .set({ status: "answered", answer: p.answer, answeredBy: p.userId ?? null, answeredAt: new Date() })
      .where(eq(escalations.id, id))
      .returning();
    await this.deps.conversations.update(conversation.id, { status: "active" });

    if (p.saveAsKnowledge) {
      await this.deps.knowledge.add({
        question: p.knowledgeQuestion?.trim() || escalation.question,
        answer: p.answer,
        productId: p.productSpecific === false ? null : escalation.productId,
        source: "escalation",
        escalationId: escalation.id,
      });
    }
    return updated!;
  }

  async dismiss(id: string): Promise<void> {
    const [row] = await this.deps.db.update(escalations).set({ status: "dismissed" }).where(eq(escalations.id, id)).returning();
    if (row) await this.deps.conversations.update(row.conversationId, { status: "active" });
  }
}
