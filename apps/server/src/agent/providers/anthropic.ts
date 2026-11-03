import Anthropic from "@anthropic-ai/sdk";
import type { AgentRequest, AgentResult, ChatMessage, LlmProvider } from "./types.js";
import { ProviderError } from "./types.js";

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.parts.map((p): Anthropic.TextBlockParam | Anthropic.ImageBlockParam =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : {
            type: "image",
            source: { type: "base64", media_type: p.mediaType as Anthropic.Base64ImageSource["media_type"], data: p.data },
          },
    ),
  }));
}

function wrapError(err: unknown): never {
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    throw new ProviderError(`Anthropic temporarily unavailable: ${err.message}`, true, err);
  }
  if (err instanceof Anthropic.AuthenticationError) throw new ProviderError("Invalid Anthropic API key", false, err);
  if (err instanceof Anthropic.APIError) throw new ProviderError(`Anthropic API error ${err.status}: ${err.message}`, err.status >= 500, err);
  throw err;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    private readonly effort: "low" | "medium" | "high" = "low",
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    // Cache breakpoint on the last tool + system: they are stable across turns of all conversations.
    const lastTool = tools.at(-1);
    if (lastTool) lastTool.cache_control = { type: "ephemeral" };

    const messages = toAnthropicMessages(req.messages);
    const toolCalls: AgentResult["toolCalls"] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };

    for (let step = 0; step < req.maxSteps; step++) {
      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          tools,
          messages,
          output_config: { effort: this.effort },
        });
      } catch (err) {
        wrapError(err);
      }
      usage.inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
      usage.outputTokens += response.usage.output_tokens;

      if (response.stop_reason === "refusal") return { text: "", toolCalls, usage, finish: "refused", model: this.model };

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        return { text, toolCalls, usage, finish: "stop", model: this.model };
      }

      // Append the full assistant content (incl. thinking blocks) unchanged.
      messages.push({ role: "assistant", content: response.content });
      const results = await Promise.all(
        toolUses.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
          try {
            const output = await req.executeTool(call.name, call.input);
            toolCalls.push({ name: call.name, input: call.input, output });
            return { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(output) };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            toolCalls.push({ name: call.name, input: call.input, output: { error: message } });
            return { type: "tool_result", tool_use_id: call.id, content: message, is_error: true };
          }
        }),
      );
      // All tool results in a single user message (keeps parallel tool use working).
      messages.push({ role: "user", content: results });
    }
    return { text: "", toolCalls, usage, finish: "max_steps" };
  }

  async generateJson(req: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<unknown> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
      });
      const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "{}";
      return JSON.parse(text);
    } catch (err) {
      wrapError(err);
    }
  }
}
