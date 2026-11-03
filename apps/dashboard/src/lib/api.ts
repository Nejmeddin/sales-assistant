/** Typed client for the server REST API (same origin; Vite proxies /api in dev). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("auth:expired"));
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

// ─── Domain types (mirror of the server responses) ───────────────────────────
export type Channel = "messenger" | "instagram";
export type User = { id: string; email: string; role: "admin" | "agent" };

export type Variant = { name: string; options: string[] };
export type Product = {
  id: string;
  name: string;
  description: string;
  price: number | null;
  currency: string;
  variants: Variant[];
  inStock: boolean | null;
  active: boolean;
  images: string[];
  keywords: string[];
  fbPostIds: string[];
  adIds: string[];
  igMediaIds: string[];
  storeUrl: string | null;
  sourceUrl: string | null;
  sourceStatus: "none" | "linked" | "searching" | "matched" | "not_found";
  createdAt: string;
};
export type ProductInput = Omit<Product, "id" | "createdAt" | "sourceStatus">;

export type ProductDraft = Partial<ProductInput> & { isProduct?: boolean; postUrl?: string; error?: string };

export type Contact = { id: string; channel: Channel; pageId: string; externalId: string; displayName: string | null };
export type Conversation = {
  id: string;
  contactId: string;
  status: "active" | "escalated" | "closed";
  stage: "answering" | "collecting_order" | "ordered";
  currentProductId: string | null;
  botPausedUntil: string | null;
  lastInboundAt: string | null;
  createdAt: string;
};
export type Message = {
  id: string;
  direction: "in" | "out";
  author: "client" | "bot" | "human";
  text: string;
  attachments: { type: string; url?: string; title?: string }[];
  createdAt: string;
};
export type Order = {
  id: string;
  conversationId: string;
  productId: string | null;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  address: string | null;
  options: Record<string, string>;
  quantity: number;
  notes: string | null;
  status: "draft" | "submitted" | "synced" | "sync_failed";
  sheetTab: string | null;
  syncError: string | null;
  submittedAt: string | null;
  createdAt: string;
};
export type Escalation = {
  id: string;
  conversationId: string;
  productId: string | null;
  question: string;
  reason: string;
  status: "open" | "answered" | "dismissed";
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
};
export type KnowledgeEntry = {
  id: string;
  question: string;
  answer: string;
  productId: string | null;
  source: "manual" | "escalation";
  enabled: boolean;
  createdAt: string;
};

export type ConversationRow = { conversation: Conversation; contact: Contact; lastMessage: { text: string; createdAt: string; author: Message["author"] } | null };
export type ConversationDetail = { conversation: Conversation; contact: Contact; messages: Message[]; orders: Order[]; escalations: Escalation[] };
export type EscalationRow = { escalation: Escalation; contact: Contact; productName: string | null; lastInboundAt: string | null };
export type EscalationDetail = { escalation: Escalation; conversation: Conversation; contact: Contact; product: Product | null; messages: Message[] };
export type OrderRow = { order: Order; productName: string | null; price: number | null; currency: string | null; channel: Channel };

export type Stats = {
  days: number;
  inboundMessages: number;
  newConversations: number;
  orders: number;
  openEscalations: number;
  runs: { outcome: string; n: number; input: string | null; output: string | null; latency: number | null }[];
  perDay: { day: string; messages: number; orders: number }[];
};

// ─── Settings ────────────────────────────────────────────────────────────────
export type Settings = {
  ai: {
    provider: "gemini" | "anthropic";
    fallbackProvider: "none" | "gemini" | "anthropic";
    gemini: { apiKey: string; model: string };
    anthropic: { apiKey: string; model: string; effort: "low" | "medium" | "high" };
    maxToolSteps: number;
    historyLimit: number;
  };
  bot: {
    enabled: boolean;
    businessName: string;
    persona: string;
    defaultLanguage: string;
    currency: string;
    cashOnDelivery: boolean;
    policies: string;
    debounceMs: number;
    humanTakeoverPauseMinutes: number;
    requiredOrderFields: ("customerName" | "phone" | "city")[];
    phoneCountry: string;
    escalationMessage: string;
  };
  meta: {
    appId: string;
    appSecret: string;
    verifyToken: string;
    graphVersion: string;
    pages: { pageId: string; name: string; accessToken: string; instagramId: string; enabled: boolean }[];
  };
  notifications: {
    escalationEmails: string[];
    transport: "smtp" | "resend" | "none";
    smtp: { host: string; port: number; secure: boolean; user: string; pass: string; from: string };
    resend: { apiKey: string; from: string };
  };
  sheets: { enabled: boolean; spreadsheetId: string; serviceAccountJson: string; tabNameFormat: string; timezone: string };
  sources: { serpApiKey: string; sites: string[]; extractSpecs: boolean };
};
export type SettingsKey = keyof Settings;
export type TestResult = { ok: boolean; detail?: string; error?: string; models?: string[]; pages?: { pageId: string; ok: boolean; name?: string; error?: string }[] };
