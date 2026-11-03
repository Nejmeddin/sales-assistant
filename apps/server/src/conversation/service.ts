import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contacts, conversations, messages, type Attachment, type Referral } from "../db/schema.js";
import type { Channel } from "../channels/meta/parser.js";

export type Conversation = typeof conversations.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Message = typeof messages.$inferSelect;

export class ConversationService {
  constructor(private readonly db: Db) {}

  async getOrCreate(channel: Channel, pageId: string, externalId: string): Promise<{ contact: Contact; conversation: Conversation; created: boolean }> {
    const [inserted] = await this.db.insert(contacts).values({ channel, pageId, externalId }).onConflictDoNothing().returning();
    const contact =
      inserted ??
      (await this.db.query.contacts.findFirst({
        where: and(eq(contacts.channel, channel), eq(contacts.pageId, pageId), eq(contacts.externalId, externalId)),
      }))!;
    const [newConversation] = await this.db.insert(conversations).values({ contactId: contact.id }).onConflictDoNothing().returning();
    const conversation = newConversation ?? (await this.db.query.conversations.findFirst({ where: eq(conversations.contactId, contact.id) }))!;
    return { contact, conversation, created: Boolean(inserted) };
  }

  /** Stores an inbound message. Returns undefined when the message was already stored (webhook redelivery). */
  async addInbound(conversationId: string, msg: { mid: string; text: string; attachments: Attachment[]; referral?: Referral; at: Date }): Promise<Message | undefined> {
    const [row] = await this.db
      .insert(messages)
      .values({
        conversationId,
        direction: "in",
        author: "client",
        mid: msg.mid,
        text: msg.text,
        attachments: msg.attachments,
        referral: msg.referral ?? null,
        createdAt: msg.at,
      })
      .onConflictDoNothing({ target: messages.mid })
      .returning();
    if (row) await this.db.update(conversations).set({ lastInboundAt: msg.at }).where(eq(conversations.id, conversationId));
    return row;
  }

  async addOutbound(conversationId: string, msg: { mid?: string; text: string; author: "bot" | "human" }): Promise<Message | undefined> {
    const [row] = await this.db
      .insert(messages)
      .values({ conversationId, direction: "out", author: msg.author, mid: msg.mid ?? null, text: msg.text, processedAt: new Date() })
      .onConflictDoNothing({ target: messages.mid })
      .returning();
    await this.db.update(conversations).set({ lastOutboundAt: new Date() }).where(eq(conversations.id, conversationId));
    return row;
  }

  async messageExists(mid: string): Promise<boolean> {
    return Boolean(await this.db.query.messages.findFirst({ where: eq(messages.mid, mid), columns: { id: true } }));
  }

  async get(id: string) {
    return this.db.query.conversations.findFirst({ where: eq(conversations.id, id) });
  }

  async getWithContact(id: string): Promise<{ conversation: Conversation; contact: Contact } | undefined> {
    const [row] = await this.db
      .select({ conversation: conversations, contact: contacts })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(eq(conversations.id, id));
    return row;
  }

  async update(id: string, patch: Partial<typeof conversations.$inferInsert>): Promise<void> {
    await this.db.update(conversations).set(patch).where(eq(conversations.id, id));
  }

  async setDisplayName(contactId: string, displayName: string): Promise<void> {
    await this.db.update(contacts).set({ displayName }).where(eq(contacts.id, contactId));
  }

  async pendingInbound(conversationId: string): Promise<Message[]> {
    return this.db.query.messages.findMany({
      where: and(eq(messages.conversationId, conversationId), eq(messages.direction, "in"), isNull(messages.processedAt)),
      orderBy: asc(messages.createdAt),
    });
  }

  async markProcessed(ids: string[]): Promise<void> {
    if (ids.length) await this.db.update(messages).set({ processedAt: new Date() }).where(inArray(messages.id, ids));
  }

  /** Most recent `limit` messages, oldest first. */
  async history(conversationId: string, limit: number): Promise<Message[]> {
    const rows = await this.db.query.messages.findMany({
      where: eq(messages.conversationId, conversationId),
      orderBy: desc(messages.createdAt),
      limit,
    });
    return rows.reverse();
  }
}
