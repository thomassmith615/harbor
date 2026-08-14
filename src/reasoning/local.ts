/**
 * Local chat provider.
 *
 * Speaks the OpenAI chat-completions shape, which Ollama, llama.cpp's server,
 * and LM Studio all implement. Same reasoning as the embedder: local inference
 * is a process boundary and the boundary is HTTP, so a local model is a base
 * URL rather than a dependency.
 *
 * Tool use is not advertised. Small local models nominally support it and are
 * unreliable at multi-turn tool loops, and a task class that declares
 * `requires: ["tools"]` should skip this tier rather than fail halfway through
 * a conversation.
 */
import { ConfigurationError, UpstreamError } from "../kernel/errors.js";
import type { CompletionRequest, CompletionResult, ContentBlock, Provider } from "./provider.js";

const DEFAULT_URL = "http://127.0.0.1:11434/v1/chat/completions";
const DEFAULT_MODEL = "qwen3:4b";

interface ChatResponse {
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: { readonly content?: string };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

function flatten(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "tool_result") {
        return block.content;
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

export function localProvider(model?: string): Provider {
  const url = process.env["HARBOR_LOCAL_URL"] ?? DEFAULT_URL;
  const name = model ?? process.env["HARBOR_LOCAL_MODEL"] ?? DEFAULT_MODEL;

  return {
    id: "local",
    model: name,

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const messages = [
        ...(request.system === undefined
          ? []
          : [{ role: "system" as const, content: request.system }]),
        ...request.messages.map((message) => ({
          role: message.role,
          content: flatten(message.content),
        })),
      ];

      let response: Response;

      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: name,
            messages,
            max_tokens: request.maxTokens ?? 1024,
            stream: false,
          }),
        });
      } catch (cause: unknown) {
        throw new ConfigurationError(
          `Could not reach the local model server at ${url}`,
          "Start it (`ollama serve`) or set HARBOR_LOCAL_URL. Tasks that require a local " +
            "model will fail rather than silently going to the cloud.",
        );
      }

      const text = await response.text();

      if (!response.ok) {
        throw new UpstreamError(`Local model returned ${String(response.status)}: ${text}`, {
          status: response.status,
          hint:
            response.status === 404
              ? `Model "${name}" may not be pulled. Try \`ollama pull ${name}\`.`
              : undefined,
        });
      }

      const parsed = JSON.parse(text) as ChatResponse;
      const choice = parsed.choices?.[0];

      if (choice === undefined) {
        throw new UpstreamError(
          `Local model returned no completion: ${text.slice(0, 200)}`,
          { hint: `Check that ${url} speaks the OpenAI chat-completions shape.` },
        );
      }

      const message = choice.message?.content ?? "";

      return {
        provider: "local",
        model: parsed.model ?? name,
        content: [{ type: "text", text: message }],
        stopReason: choice.finish_reason ?? "end_turn",
        usage: {
          inputTokens: parsed.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
