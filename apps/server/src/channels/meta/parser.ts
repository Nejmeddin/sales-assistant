import { z } from "zod";
import type { Attachment, Referral } from "../../db/schema.js";

export type Channel = "messenger" | "instagram";

export type InboundEvent =
  | {
      kind: "message";
      channel: Channel;
      pageId: string;
      senderId: string;
      mid: string;
      text: string;
      attachments: Attachment[];
      referral?: Referral;
      timestamp: number;
    }
  | {
      /** A message sent *by the page* — by our bot or by a human in Meta Business Suite. */
      kind: "echo";
      channel: Channel;
      pageId: string;
      recipientId: string;
      mid: string;
      text: string;
      appId?: string;
      timestamp: number;
    }
  | {
      /** Ad click / m.me link on an existing thread, or a postback button. */
      kind: "referral";
      channel: Channel;
      pageId: string;
      senderId: string;
      referral: Referral;
      text: string;
      timestamp: number;
    };

// Meta payloads are loosely typed and evolve: validate only what we use, keep the rest.
const RawReferral = z
  .object({
    source: z.string().optional(),
    type: z.string().optional(),
    ref: z.string().optional(),
    ad_id: z.string().optional(),
    ads_context_data: z
      .object({
        ad_title: z.string().optional(),
        photo_url: z.string().optional(),
        post_id: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const RawAttachment = z
  .object({
    type: z.string(),
    payload: z
      .object({
        url: z.string().optional(),
        title: z.string().optional(),
        ig_post_media_id: z.string().optional(),
      })
      .loose()
      .nullish(),
  })
  .loose();

const RawMessaging = z
  .object({
    sender: z.object({ id: z.string() }),
    recipient: z.object({ id: z.string() }),
    timestamp: z.number().optional(),
    message: z
      .object({
        mid: z.string(),
        text: z.string().optional(),
        is_echo: z.boolean().optional(),
        app_id: z.union([z.string(), z.number()]).optional(),
        is_deleted: z.boolean().optional(),
        attachments: z.array(RawAttachment).optional(),
        referral: RawReferral.optional(),
        quick_reply: z.object({ payload: z.string() }).loose().optional(),
      })
      .loose()
      .optional(),
    referral: RawReferral.optional(),
    postback: z
      .object({ title: z.string().optional(), payload: z.string().optional(), referral: RawReferral.optional() })
      .loose()
      .optional(),
  })
  .loose();

const RawWebhook = z.object({
  object: z.string(),
  entry: z.array(
    z
      .object({
        id: z.string(),
        time: z.number().optional(),
        messaging: z.array(z.unknown()).optional(),
      })
      .loose(),
  ),
});

function toReferral(raw: z.infer<typeof RawReferral> | undefined): Referral | undefined {
  if (!raw) return undefined;
  const ctx = raw.ads_context_data;
  return {
    source: raw.source,
    adId: raw.ad_id,
    ref: raw.ref,
    postId: ctx?.post_id,
    adTitle: ctx?.ad_title,
    photoUrl: ctx?.photo_url,
  };
}

function toAttachment(raw: z.infer<typeof RawAttachment>): Attachment {
  return {
    type: raw.type,
    url: raw.payload?.url,
    title: raw.payload?.title,
    mediaId: raw.payload?.ig_post_media_id,
  };
}

/**
 * Normalises a Messenger or Instagram webhook body into channel-agnostic events.
 * `resolvePageId` maps an Instagram account id to the Facebook page it is linked to.
 */
export function parseWebhook(body: unknown, resolvePageId: (instagramId: string) => string | undefined): InboundEvent[] {
  const parsed = RawWebhook.safeParse(body);
  if (!parsed.success) return [];
  const { object, entry } = parsed.data;
  if (object !== "page" && object !== "instagram") return [];
  const channel: Channel = object === "page" ? "messenger" : "instagram";

  const events: InboundEvent[] = [];
  for (const e of entry) {
    const pageId = channel === "messenger" ? e.id : resolvePageId(e.id);
    if (!pageId) continue;

    for (const rawItem of e.messaging ?? []) {
      const item = RawMessaging.safeParse(rawItem);
      if (!item.success) continue;
      const m = item.data;
      const timestamp = m.timestamp ?? e.time ?? Date.now();

      if (m.message) {
        if (m.message.is_deleted) continue;
        if (m.message.is_echo) {
          events.push({
            kind: "echo",
            channel,
            pageId,
            recipientId: m.recipient.id,
            mid: m.message.mid,
            text: m.message.text ?? "",
            appId: m.message.app_id === undefined ? undefined : String(m.message.app_id),
            timestamp,
          });
          continue;
        }
        events.push({
          kind: "message",
          channel,
          pageId,
          senderId: m.sender.id,
          mid: m.message.mid,
          text: m.message.text ?? "",
          attachments: (m.message.attachments ?? []).map(toAttachment),
          referral: toReferral(m.message.referral ?? m.referral),
          timestamp,
        });
        continue;
      }

      const referral = toReferral(m.referral ?? m.postback?.referral);
      if (referral || m.postback) {
        events.push({
          kind: "referral",
          channel,
          pageId,
          senderId: m.sender.id,
          referral: referral ?? { source: "POSTBACK", ref: m.postback?.payload },
          text: m.postback?.title ?? "",
          timestamp,
        });
      }
    }
  }
  return events;
}
