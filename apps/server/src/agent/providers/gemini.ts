import { ApiError, GoogleGenAI, type Content, type Part } from "@google/genai";
import type { AgentRequest, AgentResult, ChatMessage, LlmProvider } from "./types.js";
import { ProviderError } from "./types.js";

function toGeminiContents(messages: ChatMessage[]): Content[] {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: m.parts.map((p): Part => (p.type === "text" ? { text: p.text } : { inlineData: { mimeType: p.mediaType, data: p.data } })),
  }));
}

function wrapError(err: unknown): never {
  if (err instanceof ApiError) {
    // 429 = free-tier quota; 5xx = transient.
    throw new ProviderError(`Gemini API error ${err.status}: ${err.message}`, err.status === 429 || err.status >= 500, err);
  }
  throw err;
}

/** JSON-Schema keywords Gemini's function declarations reject. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const { $schema: _s, additionalProperties: _a, ...rest } = schema as Record<string, unknown>;
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, sanitizeSchema(v)]));
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    const contents = toGeminiContents(req.messages);
    const toolCalls: AgentResult["toolCalls"] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const functionDeclarations = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: sanitizeSchema(t.inputSchema),
    }));

    for (let step = 0; step < req.maxSteps; step++) {
      let response;
      try {
        response = await this.client.models.generateContent({
          model: this.model,
          contents,
          config: {
            systemInstruction: req.system,
            tools: [{ functionDeclarations }],
            automaticFunctionCalling: { disable: true },
          },
        });
      } catch (err) {
        wrapError(err);
      }
      usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
      usage.outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;

      const candidate = response.candidates?.[0];
      if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "PROHIBITED_CONTENT") {
        return { text: "", toolCalls, usage, finish: "refused" };
      }
      const calls = response.functionCalls ?? [];
      if (calls.length === 0) {
        return { text: (response.text ?? "").trim(), toolCalls, usage, finish: "stop" };
      }

      // Replay the model turn verbatim: it carries thought signatures required by Gemini 2.5+/3.
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
    return { text: "", toolCalls, usage, finish: "max_steps" };
  }

  async generateJson(req: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<unknown> {
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: req.prompt,
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: sanitizeSchema(req.schema),
        },
      });
      return JSON.parse(response.text ?? "{}");
    } catch (err) {
      wrapError(err);
    }
  }

  /** Lists models available to the key (dashboard "test connection"). */
  async listModels(): Promise<string[]> {
    const pager = await this.client.models.list();
    const names: string[] = [];
    for await (const m of pager) if (m.name) names.push(m.name.replace(/^models\//, ""));
    return names;
  }
}
