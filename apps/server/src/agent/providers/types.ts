export type ContentPart = { type: "text"; text: string } | { type: "image"; mediaType: string; data: string /* base64 */ };

/** Provider-neutral history: past turns are replayed as plain text (+ images). */
export type ChatMessage = { role: "user" | "assistant"; parts: ContentPart[] };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) of the tool input. */
  inputSchema: Record<string, unknown>;
};

export type ToolExecutor = (name: string, input: unknown) => Promise<unknown>;

export type AgentRequest = {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  executeTool: ToolExecutor;
  maxSteps: number;
};

export type AgentResult = {
  text: string;
  toolCalls: { name: string; input: unknown; output: unknown }[];
  usage: { inputTokens: number; outputTokens: number };
  /** "refused": the model declined (safety). "max_steps": tool loop did not converge. */
  finish: "stop" | "refused" | "max_steps";
};

/**
 * Each adapter runs its own tool loop so that provider-specific state
 * (Gemini thought signatures, Claude thinking blocks) is passed back verbatim.
 */
export interface LlmProvider {
  readonly name: "gemini" | "anthropic";
  readonly model: string;
  runAgent(req: AgentRequest): Promise<AgentResult>;
  /** Single structured-output call (no tools), used for extraction jobs. */
  generateJson(req: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<unknown>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
