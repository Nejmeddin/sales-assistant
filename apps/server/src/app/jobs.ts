import { z } from "zod";
import { JOB_CONVERSATION_REPLY, ReplyService, toChatHistory } from "../agent/reply.js";
import { JOB_ORDER_SHEET } from "../agent/tools.js";
import { EscalationService, JOB_ESCALATION_EMAIL } from "../escalation/service.js";
import { formatInZone } from "../integrations/sheets.js";
import { logger } from "../lib/logger.js";
import { escalationEmail } from "../notify/mailer.js";
import type { Deps } from "./deps.js";

const ConversationPayload = z.object({ conversationId: z.string().uuid() });
const EscalationPayload = z.object({ escalationId: z.string().uuid() });
const OrderPayload = z.object({ orderId: z.string().uuid() });

export function registerJobs(deps: Deps): void {
  const replies = new ReplyService(deps);
  const escalations = new EscalationService(deps);

  deps.queue.register(JOB_CONVERSATION_REPLY, async (payload, job) => {
    const { conversationId } = ConversationPayload.parse(payload);
    await replies.handle(conversationId, job.attempts);
  });

  deps.queue.register(JOB_ESCALATION_EMAIL, async (payload) => {
    const { escalationId } = EscalationPayload.parse(payload);
    const escalation = await escalations.get(escalationId);
    if (!escalation || escalation.status !== "open") return;
    const [notifications, bot] = await Promise.all([deps.settings.get("notifications"), deps.settings.get("bot")]);
    const mailer = deps.createMailer(notifications);
    if (!mailer || notifications.escalationEmails.length === 0) {
      logger.warn({ escalationId }, "No e-mail transport/recipient configured: escalation visible in the dashboard only");
      return;
    }
    const found = await deps.conversations.getWithContact(escalation.conversationId);
    const product = escalation.productId ? await deps.products.get(escalation.productId) : undefined;
    const transcript = toChatHistory(await deps.conversations.history(escalation.conversationId, 10)).map((m) => ({
      author: m.role === "user" ? "Client" : "Boutique",
      text: m.parts.map((p) => (p.type === "text" ? p.text : "[image]")).join(" "),
    }));
    await mailer.send({
      to: notifications.escalationEmails,
      ...escalationEmail({
        businessName: bot.businessName,
        clientName: found?.contact.displayName ?? "Client",
        channel: found?.contact.channel === "instagram" ? "Instagram" : "Messenger",
        question: escalation.question,
        reason: escalation.reason,
        productName: product?.name,
        transcript,
        answerUrl: `${deps.publicUrl}/escalations/${escalation.id}`,
      }),
    });
  });

  deps.queue.register(JOB_ORDER_SHEET, async (payload, job) => {
    const { orderId } = OrderPayload.parse(payload);
    const order = await deps.orders.get(orderId);
    if (!order || order.status === "synced") return;
    const sheets = await deps.settings.get("sheets");
    if (!sheets.enabled || !sheets.spreadsheetId || !sheets.serviceAccountJson) return;

    const found = await deps.conversations.getWithContact(order.conversationId);
    const product = order.productId ? await deps.products.get(order.productId) : undefined;
    const at = order.submittedAt ?? new Date();
    const tab = formatInZone(at, sheets.timezone, sheets.tabNameFormat);
    try {
      await deps.createSheets(sheets.spreadsheetId, sheets.serviceAccountJson).appendRow(tab, [
        formatInZone(at, sheets.timezone, "HH:mm"),
        order.customerName ?? "",
        order.phone ?? "",
        order.city ?? "",
        order.address ?? "",
        product?.name ?? "",
        Object.entries(order.options).map(([k, v]) => `${k}: ${v}`).join(", "),
        order.quantity,
        product?.price ?? "",
        found?.contact.channel === "instagram" ? "Instagram" : "Messenger",
        order.notes ?? "",
        `${deps.publicUrl}/conversations/${order.conversationId}`,
        order.id,
      ]);
      await deps.orders.markSynced(order.id, tab);
    } catch (err) {
      await deps.orders.markSyncFailed(order.id, err instanceof Error ? err.message : String(err));
      if (job.attempts < 5) throw err;
    }
  });
}
