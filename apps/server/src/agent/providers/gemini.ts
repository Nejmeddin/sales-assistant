import { ApiError, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentParameters, type GenerateContentResponse, type Part } from "@google/genai";
import { logger } from "../../lib/logger.js";
import type { AgentRequest, AgentResult, ChatMessage, LlmProvider } from "./types.js";
import { ProviderError } from "./types.js";

function toGeminiContents(messages: ChatMessage[]): Content[] {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: m.parts.map((p): Part => (p.type === "text" ? { text: p.text } : { inlineData: { mimeType: p.mediaType, data: p.data } })),
  }));
}

/** JSON-Schema keywords Gemini's function declarations reject. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const { $schema: _s, additionalProperties: _a, ...rest } = schema as Record<string, unknown>;
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, sanitizeSchema(v)]));
}

/** 429 (free-tier quota), 503 (overloaded), 500/504: worth retrying or switching model. 404: model retired. */
const isTransient = (e: ApiError) => e.status === 429 || e.status >= 500;
const isModelUnavailable = (e: ApiError) => isTransient(e) || e.status === 404;
/** The SDK has no client-side timeout by default: we set one, and treat it like an overload. */
const REQUEST_TIMEOUT_MS = 20_000;
const isTimeout = (e: unknown) => e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError" || /timed? ?out|aborted/i.test(e.message));

/** Server-suggested delay ("Please retry in 1.41s" / RetryInfo), capped. */
export function retryDelayMs(err: ApiError, attempt: number): number {
  const m = err.message.match(/retry in ([\d.]+)s/i) ?? err.message.match(/"retryDelay":\s*"([\d.]+)s"/);
  const suggested = m ? Number(m[1]) * 1000 : 0;
  return Math.min(Math.max(suggested, 1000 * 2 ** attempt), 15_000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Process-wide memory of models that recently failed, so the next replies skip them
 * instead of paying a failed round-trip: quota (429) for the server-suggested delay,
 * overload (503) for a minute, retired models (404) for a day.
 */
const cooldownUntil = new Map<string, number>();

function cooldownMs(err: ApiError | Error): number {
  if (!(err instanceof ApiError)) return 60_000; // timeout
  if (err.status === 404) return 24 * 3_600_000;
  if (err.status === 429) return retryDelayMs(err, 0);
  return 60_000;
}

export function orderByAvailability(models: string[], now = Date.now()): string[] {
  const ready = models.filter((m) => (cooldownUntil.get(m) ?? 0) <= now);
  const cooling = models.filter((m) => !ready.includes(m)).sort((a, b) => cooldownUntil.get(a)! - cooldownUntil.get(b)!);
  return [...ready, ...cooling]; // never empty: cooled models are still a last resort
}

export function resetModelCooldowns(): void {
  cooldownUntil.clear();
}

/**
 * Gemini adapter with a model fallback chain. Free-tier quotas are per model, so
 * falling back to another Flash model both survives "high demand" spikes and
 * multiplies the free capacity.
 *
 * A model is chosen on the first step of a run and kept for the rest of the tool
 * loop (thought signatures are model-bound); mid-run errors are retried in place.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  private readonly client: GoogleGenAI;
  private readonly models: string[];

  constructor(
    apiKey: string,
    readonly model: string,
    fallbackModels: string[] = [],
    private readonly opts: { maxRetriesPerModel?: number; sleep?: (ms: number) => Promise<unknown>; thinkingLevel?: keyof typeof ThinkingLevel } = {},
  ) {
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
    this.models = [...new Set([model, ...fallbackModels].filter(Boolean))];
  }

  private async callModel(model: string, params: Omit<GenerateContentParameters, "model">): Promise<GenerateContentResponse> {
    const retries = this.opts.maxRetriesPerModel ?? 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.models.generateContent({ ...params, model });
      } catch (err) {
        // Retry the same model only for quota (429): overload (503) is better served by the next model.
        if (err instanceof ApiError && err.status === 429 && attempt < retries) {
          await (this.opts.sleep ?? sleep)(retryDelayMs(err, attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * First step: try every model that is not cooling down, without waiting — a model out of
   * quota or overloaded hands over to the next one immediately. If all of them failed,
   * wait for the model that recovers first (at most MAX_WAIT_MS) and try it once more.
   */
  private async firstAvailable(params: Omit<GenerateContentParameters, "model">): Promise<{ model: string; response: GenerateContentResponse }> {
    const MAX_WAIT_MS = 15_000;
    let last: unknown = new Error("No Gemini model configured");
    const attempt = async (model: string) => {
      try {
        const response = await this.client.models.generateContent({ ...params, model });
        cooldownUntil.delete(model);
        return { model, response };
      } catch (err) {
        const unavailable = (err instanceof ApiError && isModelUnavailable(err)) || isTimeout(err);
        if (!unavailable) throw this.wrap(err);
        last = err;
        cooldownUntil.set(model, Date.now() + cooldownMs(err as Error));
        logger.warn({ model, status: err instanceof ApiError ? err.status : "timeout" }, "Gemini model unavailable, trying next fallback");
        return undefined;
      }
    };

    const now = Date.now();
    for (const model of this.models.filter((m) => (cooldownUntil.get(m) ?? 0) <= now)) {
      const hit = await attempt(model);
      if (hit) return hit;
    }
    const [soonest] = orderByAvailability(this.models).filter((m) => (cooldownUntil.get(m) ?? 0) - Date.now() <= MAX_WAIT_MS);
    if (soonest) {
      await (this.opts.sleep ?? sleep)(Math.max(0, (cooldownUntil.get(soonest) ?? 0) - Date.now()));
      const hit = await attempt(soonest);
      if (hit) return hit;
    }
    throw this.wrap(last);
  }

  private wrap(err: unknown): Error {
    if (err instanceof ApiError) {
      return new ProviderError(`Gemini API error ${err.status}: ${err.message.slice(0, 300)}`, isTransient(err) || err.status === 404, err);
    }
    if (isTimeout(err)) return new ProviderError(`Gemini request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`, true, err);
    return err instanceof Error ? err : new Error(String(err));
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    const contents = toGeminiContents(req.messages);
    const toolCalls: AgentResult["toolCalls"] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const config = {
      systemInstruction: req.system,
      ...(this.opts.thinkingLevel ? { thinkingConfig: { thinkingLevel: ThinkingLevel[this.opts.thinkingLevel] } } : {}),
      ...(req.tools.length
        ? {
            tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: sanitizeSchema(t.inputSchema) })) }],
            automaticFunctionCalling: { disable: true },
          }
        : {}),
    };

    let model: string | undefined;
    for (let step = 0; step < req.maxSteps; step++) {
      let response: GenerateContentResponse;
      if (!model) {
        ({ model, response } = await this.firstAvailable({ contents, config }));
      } else {
        try {
          response = await this.callModel(model, { contents, config });
        } catch (err) {
          throw this.wrap(err);
        }
      }
      usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
      usage.outputTokens += (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0);

      const candidate = response.candidates?.[0];
      if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "PROHIBITED_CONTENT") {
        return { text: "", toolCalls, usage, finish: "refused", model };
      }
      const calls = response.functionCalls ?? [];
      if (calls.length === 0) {
        return { text: (response.text ?? "").trim(), toolCalls, usage, finish: "stop", model };
      }

      // Replay the model turn verbatim: it carries the thought signatures Gemini 3 requires.
      if (candidate?.content) contents.push(candidate.content);
      const responseParts: Part[] = await Promise.all(
        calls.map(async (call): Promise<Part> => {
          const name = call.name ?? "";
          try {
            const output = await req.executeTool(name, call.args ?? {});
            toolCalls.push({ name, input: call.args, output });
            return { functionResponse: { id: call.id, name, response: { result: output } } };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            toolCalls.push({ name, input: call.args, output: { error: message } });
            return { functionResponse: { id: call.id, name, response: { error: message } } };
          }
        }),
      );
      contents.push({ role: "user", parts: responseParts });
    }
    return { text: "", toolCalls, usage, finish: "max_steps", model };
  }

  async generateJson(req: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<unknown> {
    const { response } = await this.firstAvailable({
      contents: req.prompt,
      config: { systemInstruction: req.system, responseMimeType: "application/json", responseJsonSchema: sanitizeSchema(req.schema) },
    });
    return JSON.parse(response.text ?? "{}");
  }

  /** Lists models available to the key (dashboard "test connection"). */
  async listModels(): Promise<string[]> {
    const pager = await this.client.models.list();
    const names: string[] = [];
    for await (const m of pager) {
      if (m.name && m.supportedActions?.includes("generateContent")) names.push(m.name.replace(/^models\//, ""));
    }
    return names;
  }
}
