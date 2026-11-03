import { z } from "zod";
import type { Channel } from "./parser.js";

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = "MetaApiError";
  }

  /** Outside the 24-hour window (needs a message tag) or user unreachable. */
  get isWindowClosed(): boolean {
    return this.code === 10 || this.subcode === 2018278 || this.subcode === 2534022;
  }
}

export type MetaPageCredentials = { pageId: string; accessToken: string };

const MAX_LEN: Record<Channel, number> = { messenger: 2000, instagram: 1000 };

/** Splits a reply into chunks under the channel limit, preferring paragraph then sentence boundaries. */
export function splitMessage(text: string, channel: Channel): string[] {
  const limit = MAX_LEN[channel];
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
    const at = cut > limit * 0.5 ? cut + 1 : limit;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export type FetchLike = typeof fetch;

export class MetaClient {
  constructor(
    private readonly graphVersion: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private url(path: string, token: string, params: Record<string, string> = {}): string {
    const qs = new URLSearchParams({ ...params, access_token: token });
    return `https://graph.facebook.com/${this.graphVersion}/${path}?${qs}`;
  }

  private async call<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } };
    if (!res.ok || body.error) {
      throw new MetaApiError(body.error?.message ?? `Graph API ${res.status}`, res.status, body.error?.code, body.error?.error_subcode);
    }
    return body as T;
  }

  /**
   * Sends a text message. Inside the 24h window use the default RESPONSE type; for a late
   * human answer pass `tag: "HUMAN_AGENT"` (allowed up to 7 days, requires the permission).
   */
  async sendText(page: MetaPageCredentials, recipientId: string, text: string, opts: { tag?: "HUMAN_AGENT" } = {}): Promise<string> {
    const body = {
      recipient: { id: recipientId },
      message: { text },
      messaging_type: opts.tag ? "MESSAGE_TAG" : "RESPONSE",
      ...(opts.tag ? { tag: opts.tag } : {}),
    };
    const res = await this.call<{ message_id: string }>(this.url(`${page.pageId}/messages`, page.accessToken), {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res.message_id;
  }

  async senderAction(page: MetaPageCredentials, recipientId: string, action: "typing_on" | "typing_off" | "mark_seen"): Promise<void> {
    await this.call(this.url(`${page.pageId}/messages`, page.accessToken), {
      method: "POST",
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: action }),
    });
  }

  async getProfileName(page: MetaPageCredentials, userId: string, channel: Channel): Promise<string | undefined> {
    const fields = channel === "instagram" ? "name,username" : "first_name,last_name";
    const res = await this.call<Record<string, string>>(this.url(userId, page.accessToken, { fields }));
    if (channel === "instagram") return res.name ?? res.username;
    return [res.first_name, res.last_name].filter(Boolean).join(" ") || undefined;
  }

  async listPagePosts(page: MetaPageCredentials, limit = 25): Promise<PagePost[]> {
    const res = await this.call<{ data: unknown[] }>(
      this.url(`${page.pageId}/posts`, page.accessToken, {
        fields: "id,message,created_time,permalink_url,full_picture",
        limit: String(limit),
      }),
    );
    return z.array(PagePost).parse(res.data);
  }

  /** Validates a page token and returns the page name (dashboard "test connection"). */
  async checkPage(page: MetaPageCredentials): Promise<{ id: string; name: string }> {
    return this.call(this.url(page.pageId, page.accessToken, { fields: "id,name" }));
  }
}

export const PagePost = z.object({
  id: z.string(),
  message: z.string().optional(),
  created_time: z.string(),
  permalink_url: z.string().optional(),
  full_picture: z.string().optional(),
});
export type PagePost = z.infer<typeof PagePost>;
