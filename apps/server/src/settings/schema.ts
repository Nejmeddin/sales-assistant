import { z } from "zod";

/**
 * Everything configurable from the dashboard. Each top-level key is stored as one
 * row in the `settings` table. Fields listed in SECRET_FIELDS are encrypted at rest
 * and never returned in clear text by the API (masked as "••••last4").
 */

export const AiSettings = z.object({
  /** Provider used for conversations. */
  provider: z.enum(["gemini", "anthropic"]).default("gemini"),
  /** Optional backup provider if the main one errors (quota, outage). */
  fallbackProvider: z.enum(["none", "gemini", "anthropic"]).default("none"),
  gemini: z
    .object({
      apiKey: z.string().default(""),
      model: z.string().default("gemini-2.5-flash"),
    })
    .default({ apiKey: "", model: "gemini-2.5-flash" }),
  anthropic: z
    .object({
      apiKey: z.string().default(""),
      model: z.string().default("claude-haiku-5-5"),
      effort: z.enum(["low", "medium", "high"]).default("low"),
    })
    .default({ apiKey: "", model: "claude-haiku-5-5", effort: "low" }),
  maxToolSteps: z.number().int().min(1).max(12).default(6),
  /** Number of past messages replayed to the model. */
  historyLimit: z.number().int().min(4).max(100).default(30),
});

export const BotSettings = z.object({
  enabled: z.boolean().default(true),
  businessName: z.string().default("Africa Smile"),
  /** Free-text persona / tone guidance. */
  persona: z
    .string()
    .default(
      "Tu es l'assistant(e) commercial(e) de la boutique. Ton ton est chaleureux, amical et positif, avec des emojis adaptés (sans excès). Tu tutoies ou vouvoies selon le client.",
    ),
  defaultLanguage: z.string().default("fr"),
  currency: z.string().default("TND"),
  cashOnDelivery: z.boolean().default(true),
  /** Extra policies the bot may state (delivery delays, zones…). Empty ⇒ escalate such questions. */
  policies: z.string().default(""),
  /** Wait for the client to stop typing before answering (ms). */
  debounceMs: z.number().int().min(0).max(30_000).default(4_000),
  /** When a human replies from Meta Business Suite, the bot pauses for this conversation. */
  humanTakeoverPauseMinutes: z.number().int().min(0).max(10_080).default(720),
  /** Fields required to submit an order (variant options of the product are always required). */
  requiredOrderFields: z
    .array(z.enum(["customerName", "phone", "city"]))
    .default(["customerName", "phone", "city"]),
  /** Default country for phone numbers without international prefix. */
  phoneCountry: z.string().length(2).default("TN"),
  /** Message sent when escalating (the AI adapts it to the client's language). */
  escalationMessage: z
    .string()
    .default("Je vérifie cette information avec l'équipe et je reviens vers toi très vite 🙏"),
});

export const MetaPage = z.object({
  pageId: z.string().min(1),
  name: z.string().default(""),
  accessToken: z.string().default(""),
  /** Instagram professional account linked to the page (enables Instagram DMs). */
  instagramId: z.string().default(""),
  enabled: z.boolean().default(true),
});

export const MetaSettings = z.object({
  appId: z.string().default(""),
  appSecret: z.string().default(""),
  /** Arbitrary string you also enter in the Meta developer console. */
  verifyToken: z.string().default(""),
  graphVersion: z.string().default("v26.0"),
  pages: z.array(MetaPage).default([]),
});

export const NotificationSettings = z.object({
  escalationEmails: z.array(z.string().email()).default([]),
  transport: z.enum(["smtp", "resend", "none"]).default("none"),
  smtp: z
    .object({
      host: z.string().default("smtp.gmail.com"),
      port: z.number().int().default(465),
      secure: z.boolean().default(true),
      user: z.string().default(""),
      pass: z.string().default(""),
      from: z.string().default(""),
    })
    .default({ host: "smtp.gmail.com", port: 465, secure: true, user: "", pass: "", from: "" }),
  resend: z
    .object({ apiKey: z.string().default(""), from: z.string().default("") })
    .default({ apiKey: "", from: "" }),
});

export const SheetsSettings = z.object({
  enabled: z.boolean().default(false),
  spreadsheetId: z.string().default(""),
  /** Google service-account JSON key (share the spreadsheet with its client_email). */
  serviceAccountJson: z.string().default(""),
  /** Tab name pattern: YYYY, MM, DD tokens. One tab per day. */
  tabNameFormat: z.string().default("YYYY-MM-DD"),
  timezone: z.string().default("Africa/Tunis"),
});

export const SourcesSettings = z.object({
  /** SerpApi key for Google Lens visual search (finds the same product on AliExpress / Alibaba). */
  serpApiKey: z.string().default(""),
  sites: z.array(z.string()).default(["aliexpress.com", "alibaba.com"]),
  /** Use the configured AI provider to extract specs from the source page. */
  extractSpecs: z.boolean().default(true),
});

export const SettingsSchema = {
  ai: AiSettings,
  bot: BotSettings,
  meta: MetaSettings,
  notifications: NotificationSettings,
  sheets: SheetsSettings,
  sources: SourcesSettings,
} as const;

export type SettingsKey = keyof typeof SettingsSchema;
export type Settings = { [K in SettingsKey]: z.infer<(typeof SettingsSchema)[K]> };

/** Dotted paths (with `[]` for arrays) of fields encrypted at rest and masked in API responses. */
export const SECRET_FIELDS: { [K in SettingsKey]: string[] } = {
  ai: ["gemini.apiKey", "anthropic.apiKey"],
  bot: [],
  meta: ["appSecret", "pages[].accessToken"],
  notifications: ["smtp.pass", "resend.apiKey"],
  sheets: ["serviceAccountJson"],
  sources: ["serpApiKey"],
};
