import { createHmac, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { Auth } from "../src/api/auth.js";
import { createDeps, type Deps } from "../src/app/deps.js";
import { createHttpApp } from "../src/app/http.js";
import { registerJobs } from "../src/app/jobs.js";
import { createDb, runMigrations, type Db } from "../src/db/client.js";
import type { AgentRequest, AgentResult, LlmProvider } from "../src/agent/providers/types.js";
import type { Email, Mailer } from "../src/notify/mailer.js";
import type { SheetsWriter } from "../src/integrations/sheets.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

export const PAGE_ID = "138276736030527";
export const IG_ID = "17841400000000000";
export const APP_ID = "999000111";
export const APP_SECRET = "test-app-secret";
export const ENCRYPTION_KEY = randomBytes(32).toString("base64");

/** Scripted LLM: each call to runAgent consumes the next step function. */
export type Script = (req: AgentRequest) => Promise<string>;

export class FakeProvider implements LlmProvider {
  readonly name = "gemini" as const;
  readonly model = "fake-model";
  readonly requests: AgentRequest[] = [];
  /** Assertion failures inside scripted steps (otherwise swallowed by the bot's fallback). */
  readonly errors: unknown[] = [];
  constructor(private readonly script: Script[]) {}
  async runAgent(req: AgentRequest): Promise<AgentResult> {
    this.requests.push(req);
    const step = this.script.shift();
    if (!step) throw new Error("FakeProvider: no scripted step left");
    const toolCalls: AgentResult["toolCalls"] = [];
    const wrapped: AgentRequest = {
      ...req,
      executeTool: async (name, input) => {
        const output = await req.executeTool(name, input);
        toolCalls.push({ name, input, output });
        return output;
      },
    };
    let text: string;
    try {
      text = await step(wrapped);
    } catch (err) {
      this.errors.push(err);
      throw err;
    }
    return { text, toolCalls, usage: { inputTokens: 100, outputTokens: 20 }, finish: "stop" };
  }
  async generateJson(): Promise<unknown> {
    return {};
  }
}

export type GraphCall = { method: string; path: string; body?: Record<string, unknown> };

/** Fake Graph API: records calls and answers sends with incrementing message ids. */
export function fakeGraph() {
  const calls: GraphCall[] = [];
  let n = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname.replace(/^\/v[\d.]+\//, ""), body });
    if (url.hostname !== "graph.facebook.com") return new Response("not found", { status: 404 });
    if (body?.sender_action) return Response.json({ recipient_id: "x" });
    if (body?.message) return Response.json({ recipient_id: "x", message_id: `m_out_${++n}` });
    if (url.searchParams.get("fields")?.includes("first_name")) return Response.json({ first_name: "Amine", last_name: "Ben Ali" });
    return Response.json({});
  }) as typeof fetch;
  const sent = () => calls.filter((c) => c.body?.message).map((c) => ({ to: (c.body!.recipient as { id: string }).id, text: (c.body!.message as { text: string }).text, tag: c.body!.tag }));
  return { calls, fetchImpl, sent };
}

export class FakeMailer implements Mailer {
  readonly sent: Email[] = [];
  async send(email: Email) {
    this.sent.push(email);
  }
}

export class FakeSheets implements SheetsWriter {
  readonly rows: { tab: string; row: (string | number)[] }[] = [];
  async appendRow(tab: string, row: (string | number)[]) {
    this.rows.push({ tab, row });
  }
}

let sharedDb: Db | undefined;

export async function testDb(): Promise<Db> {
  if (!sharedDb) {
    sharedDb = createDb(TEST_DATABASE_URL);
    await runMigrations(sharedDb);
  }
  await sharedDb.execute(sql`TRUNCATE users, settings, products, contacts, conversations, messages, orders, escalations, knowledge, jobs, agent_runs RESTART IDENTITY CASCADE`);
  return sharedDb;
}

export async function setupApp(script: Script[] = []) {
  const db = await testDb();
  const graph = fakeGraph();
  const provider = new FakeProvider(script);
  const mailer = new FakeMailer();
  const sheets = new FakeSheets();
  const deps: Deps = createDeps(
    db,
    { encryptionKey: ENCRYPTION_KEY, publicUrl: "https://bot.example.com" },
    { createProvider: () => provider, createMailer: () => mailer, createSheets: () => sheets, fetch: graph.fetchImpl },
  );
  await deps.settings.set("meta", {
    appId: APP_ID,
    appSecret: APP_SECRET,
    verifyToken: "verify-me",
    pages: [{ pageId: PAGE_ID, name: "Africa Smile", accessToken: "EAAG-page-token", instagramId: IG_ID }],
  });
  await deps.settings.set("bot", { debounceMs: 0 });
  await deps.settings.set("notifications", { escalationEmails: ["owner@example.com"], transport: "smtp" });
  await deps.settings.set("sheets", { enabled: true, spreadsheetId: "sheet-1", serviceAccountJson: "{}" });
  registerJobs(deps);
  const auth = new Auth(db, "x".repeat(32), false);
  const http = createHttpApp(deps, auth);

  /** Runs queued jobs until the queue is idle. */
  const drain = async () => {
    for (let i = 0; i < 20; i++) if ((await deps.queue.tick()) === 0) break;
    if (provider.errors.length) throw provider.errors[0];
  };

  const postWebhook = (body: unknown, secret = APP_SECRET) => {
    const raw = JSON.stringify(body);
    const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    return http.request("/webhooks/meta", { method: "POST", body: raw, headers: { "x-hub-signature-256": sig, "content-type": "application/json" } });
  };

  return { db, deps, graph, provider, mailer, sheets, http, auth, drain, postWebhook };
}

let midCounter = 0;
export function messengerText(senderId: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    object: "page",
    entry: [{ id: PAGE_ID, time: Date.now(), messaging: [{ sender: { id: senderId }, recipient: { id: PAGE_ID }, timestamp: Date.now(), message: { mid: `m_in_${++midCounter}`, text }, ...extra }] }],
  };
}
