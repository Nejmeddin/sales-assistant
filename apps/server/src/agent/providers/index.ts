import type { Settings } from "../../settings/schema.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { ProviderError, type AgentRequest, type AgentResult, type LlmProvider } from "./types.js";

export * from "./types.js";

function build(kind: "gemini" | "anthropic", ai: Settings["ai"]): LlmProvider | undefined {
  if (kind === "gemini") return ai.gemini.apiKey ? new GeminiProvider(ai.gemini.apiKey, ai.gemini.model, ai.gemini.fallbackModels, { thinkingLevel: ai.gemini.thinkingLevel }) : undefined;
  return ai.anthropic.apiKey ? new AnthropicProvider(ai.anthropic.apiKey, ai.anthropic.model, ai.anthropic.effort) : undefined;
}

/** Wraps the primary provider with an optional fallback used on retryable errors (quota, outage). */
class FallbackProvider implements LlmProvider {
  constructor(
    private readonly primary: LlmProvider,
    private readonly fallback: LlmProvider,
  ) {}
  get name() {
    return this.primary.name;
  }
  get model() {
    return this.primary.model;
  }
  async runAgent(req: AgentRequest): Promise<AgentResult & { servedBy?: string }> {
    try {
      return await this.primary.runAgent(req);
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) return { ...(await this.fallback.runAgent(req)), servedBy: this.fallback.name };
      throw err;
    }
  }
  async generateJson(req: Parameters<LlmProvider["generateJson"]>[0]) {
    try {
      return await this.primary.generateJson(req);
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) return this.fallback.generateJson(req);
      throw err;
    }
  }
}

export type ProviderFactory = (ai: Settings["ai"]) => LlmProvider;

export const createProvider: ProviderFactory = (ai) => {
  const primary = build(ai.provider, ai);
  if (!primary) throw new ProviderError(`No API key configured for ${ai.provider}`, false);
  const fallback = ai.fallbackProvider !== "none" && ai.fallbackProvider !== ai.provider ? build(ai.fallbackProvider, ai) : undefined;
  return fallback ? new FallbackProvider(primary, fallback) : primary;
};
