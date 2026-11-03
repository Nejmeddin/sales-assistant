import { and, eq } from "drizzle-orm";
import type { Deps } from "../app/deps.js";
import { splitMessage } from "../channels/meta/client.js";
import { findPage } from "../channels/meta/pages.js";
import type { Channel } from "../channels/meta/parser.js";
import { agentRuns, escalations, type Attachment } from "../db/schema.js";
import { EscalationService } from "../escalation/service.js";
import { logger } from "../lib/logger.js";
import { missingFields } from "../orders/service.js";
import type { Message } from "../conversation/service.js";
import { buildContextBlock, buildSystemPrompt } from "./prompt.js";
import { ProviderError, type AgentResult, type ChatMessage, type ContentPart } from "./providers/types.js";
import { buildTools, type TurnState } from "./tools.js";

export const JOB_CONVERSATION_REPLY = "conversation.reply";

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** After this many failed attempts on a transient AI error, hand the conversation to a human. */
const MAX_AI_ATTEMPTS = 3;
/** A reply asking for the phone number = the order invitation (or order collection) has started. FR / EN / AR. */
const INVITATION_HINT = /t[ée]l[ée]phone|num[ée]ro|phone number|رقم|نومرو/i;

function describeAttachment(a: Attachment): string {
  if (a.type === "image") return "[photo]";
  if (a.type === "audio") return "[message vocal]";
  if (a.type === "video") return "[vidéo]";
  return `[${a.type}${a.title ? `: ${a.title}` : ""}${a.url ? ` ${a.url}` : ""}]`;
}

function messageText(m: Message): string {
  return [m.text, ...m.attachments.map(describeAttachment)].filter(Boolean).join(" ").trim() || "[message vide]";
}

/** Converts stored messages to alternating user/assistant turns (consecutive same-role messages merged). */
export function toChatHistory(history: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    const role = m.direction === "in" ? "user" : "assistant";
    const text = m.author === "human" ? `(réponse de l'équipe) ${m.text}` : messageText(m);
    const last = out.at(-1);
    if (last?.role === role) last.parts.push({ type: "text", text });
    else out.push({ role, parts: [{ type: "text", text }] });
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

export class ReplyService {
  private readonly escalations: EscalationService;

  constructor(private readonly deps: Deps) {
    this.escalations = new EscalationService(deps);
  }

  private async downloadImages(pending: Message[]): Promise<ContentPart[]> {
    const urls = pending.flatMap((m) => m.attachments.filter((a) => a.type === "image" && a.url).map((a) => a.url!)).slice(0, MAX_IMAGES);
    const parts: ContentPart[] = [];
    for (const url of urls) {
      try {
        const res = await this.deps.fetch(url, { signal: AbortSignal.timeout(10_000) });
        const type = res.headers.get("content-type")?.split(";")[0] ?? "";
        const buf = Buffer.from(await res.arrayBuffer());
        if (res.ok && /^image\/(jpeg|png|webp|gif)$/.test(type) && buf.length <= MAX_IMAGE_BYTES) {
          parts.push({ type: "image", mediaType: type, data: buf.toString("base64") });
        }
      } catch (err) {
        logger.debug({ err, url }, "Could not download image attachment");
      }
    }
    return parts;
  }

  async handle(conversationId: string, attempt = 1): Promise<void> {
    const { deps } = this;
    const found = await deps.conversations.getWithContact(conversationId);
    if (!found) return;
    const { conversation, contact } = found;
    const pending = await deps.conversations.pendingInbound(conversationId);
    if (pending.length === 0) return;
    const pendingIds = pending.map((m) => m.id);

    const [bot, ai, meta, sheets] = await Promise.all([
      deps.settings.get("bot"),
      deps.settings.get("ai"),
      deps.settings.get("meta"),
      deps.settings.get("sheets"),
    ]);
    const page = findPage(meta, contact.pageId);
    const paused = conversation.botPausedUntil && conversation.botPausedUntil > new Date();
    if (!bot.enabled || !page?.accessToken || paused) {
      await deps.conversations.markProcessed(pendingIds);
      return;
    }
    const credentials = { pageId: page.pageId, accessToken: page.accessToken };
    const client = deps.meta(meta.graphVersion);
    const channel = contact.channel as Channel;

    void client.senderAction(credentials, contact.externalId, "typing_on").catch(() => undefined);
    if (!contact.displayName) {
      const name = await client.getProfileName(credentials, contact.externalId, channel).catch(() => undefined);
      if (name) {
        await deps.conversations.setDisplayName(contact.id, name);
        contact.displayName = name;
      }
    }

    // ── Assemble the turn ─────────────────────────────────────────────────────
    const product = conversation.currentProductId ? await deps.products.get(conversation.currentProductId) : undefined;
    const order = await deps.orders.draft(conversationId);
    const openEscalation = await deps.db.query.escalations.findFirst({
      where: and(eq(escalations.conversationId, conversationId), eq(escalations.status, "open")),
    });
    const catalog = await deps.products.list({ activeOnly: true });

    const history = toChatHistory(await deps.conversations.history(conversationId, ai.historyLimit));
    const last = history.at(-1);
    if (!last || last.role !== "user") {
      await deps.conversations.markProcessed(pendingIds);
      return;
    }
    const context = buildContextBlock({
      channel,
      profileName: contact.displayName,
      product,
      order,
      missing: order ? missingFields(order, product, bot.requiredOrderFields) : undefined,
      openEscalation: openEscalation?.question,
      invitationSent: conversation.orderInvitationSent,
      now: new Date(),
      timezone: sheets.timezone,
    });
    last.parts.unshift({ type: "text", text: context });
    last.parts.push(...(await this.downloadImages(pending)));

    const state: TurnState = {
      conversation,
      product,
      order,
      escalated: false,
      latestClientText: pending.map((m) => m.text).join(" "),
    };
    const tools = buildTools(deps, state, bot);

    // ── Run the model ─────────────────────────────────────────────────────────
    const started = Date.now();
    let result: AgentResult | undefined;
    let providerName = ai.provider;
    let model = ai.provider === "gemini" ? ai.gemini.model : ai.anthropic.model;
    let error: string | undefined;
    try {
      const provider = deps.createProvider(ai);
      providerName = provider.name;
      model = provider.model;
      result = await provider.runAgent({
        system: buildSystemPrompt(bot, catalog),
        messages: history,
        tools: tools.specs,
        executeTool: tools.execute,
        maxSteps: ai.maxToolSteps,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // Transient (quota, outage): let the queue retry a few times before handing over.
      if (err instanceof ProviderError && err.retryable && attempt < MAX_AI_ATTEMPTS) {
        await this.recordRun(conversationId, providerName, model, started, undefined, "error", error);
        throw err;
      }
      logger.error({ err, conversationId }, "AI provider failed; escalating to a human");
    }

    let text = result?.finish === "stop" ? result.text : "";
    if (!text) {
      // Never leave the client without an answer: hand over to the team.
      if (!state.escalated && !openEscalation) {
        await this.escalations.create(conversationId, {
          question: state.latestClientText || "(message sans texte)",
          reason: error ? `Erreur de l'assistant IA : ${error}` : `L'assistant n'a pas pu répondre (${result?.finish ?? "aucune réponse"})`,
          productId: state.product?.id,
        });
        state.escalated = true;
      }
      text = bot.escalationMessage;
    }

    // ── Deliver ───────────────────────────────────────────────────────────────
    for (const chunk of splitMessage(text, channel)) {
      const mid = await client.sendText(credentials, contact.externalId, chunk);
      await deps.conversations.addOutbound(conversationId, { mid, text: chunk, author: "bot" });
    }
    await deps.conversations.markProcessed(pendingIds);
    if (!conversation.orderInvitationSent && (state.order || INVITATION_HINT.test(text))) {
      await deps.conversations.update(conversationId, { orderInvitationSent: true });
    }
    await this.recordRun(conversationId, providerName, result?.model ?? model, started, result, state.escalated ? "escalated" : "replied", error);
  }

  private async recordRun(
    conversationId: string,
    provider: string,
    model: string,
    started: number,
    result: AgentResult | undefined,
    outcome: "replied" | "escalated" | "silent" | "error",
    error?: string,
  ): Promise<void> {
    await this.deps.db.insert(agentRuns).values({
      conversationId,
      provider,
      model,
      inputTokens: result?.usage.inputTokens ?? 0,
      outputTokens: result?.usage.outputTokens ?? 0,
      toolCalls: result?.toolCalls ?? [],
      latencyMs: Date.now() - started,
      outcome,
      error: error ?? null,
    });
  }
}
