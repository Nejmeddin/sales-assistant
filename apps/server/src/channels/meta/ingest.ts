import type { Deps } from "../../app/deps.js";
import { JOB_CONVERSATION_REPLY } from "../../agent/reply.js";
import { logger } from "../../lib/logger.js";
import { findPage } from "./pages.js";
import type { InboundEvent } from "./parser.js";

/**
 * Persists webhook events (fast, DB only) and schedules the reply job.
 * Meta expects a 200 within seconds, so no AI work happens here.
 */
export async function ingestEvents(deps: Deps, events: InboundEvent[]): Promise<void> {
  if (events.length === 0) return;
  const [meta, bot] = await Promise.all([deps.settings.get("meta"), deps.settings.get("bot")]);

  for (const ev of events) {
    if (!findPage(meta, ev.pageId)) {
      logger.warn({ pageId: ev.pageId }, "Webhook event for an unknown or disabled page");
      continue;
    }

    if (ev.kind === "echo") {
      // Our own messages carry our app id; anything else was typed by a human (Business Suite, inbox app…).
      if ((meta.appId && ev.appId === meta.appId) || (await deps.conversations.messageExists(ev.mid))) continue;
      const { conversation } = await deps.conversations.getOrCreate(ev.channel, ev.pageId, ev.recipientId);
      await deps.conversations.addOutbound(conversation.id, { mid: ev.mid, text: ev.text, author: "human" });
      if (bot.humanTakeoverPauseMinutes > 0) {
        await deps.conversations.update(conversation.id, {
          botPausedUntil: new Date(Date.now() + bot.humanTakeoverPauseMinutes * 60_000),
        });
      }
      continue;
    }

    const { conversation } = await deps.conversations.getOrCreate(ev.channel, ev.pageId, ev.senderId);

    const referral = ev.referral;
    const attachment = ev.kind === "message" ? ev.attachments.find((a) => a.url || a.mediaId) : undefined;
    const product =
      (referral && (await deps.products.findByReferral(referral))) || (attachment && (await deps.products.findByAttachment(attachment)));
    if (product && product.id !== conversation.currentProductId) {
      await deps.conversations.update(conversation.id, { currentProductId: product.id });
    }

    if (ev.kind === "referral" && !ev.text) continue; // ad click without message: just remember the product
    const stored = await deps.conversations.addInbound(conversation.id, {
      mid: ev.kind === "message" ? ev.mid : `ref:${ev.senderId}:${ev.timestamp}`,
      text: ev.text,
      attachments: ev.kind === "message" ? ev.attachments : [],
      referral,
      at: new Date(ev.timestamp),
    });
    if (!stored) continue; // redelivery

    if (conversation.status === "closed") await deps.conversations.update(conversation.id, { status: "active" });
    await deps.queue.enqueue(JOB_CONVERSATION_REPLY, conversation.id, { conversationId: conversation.id }, { delayMs: bot.debounceMs, debounce: true });
  }
}
