/**
 * The provider interface, and one implementation.
 *
 * Two rules carried forward from the prototype, both load-bearing:
 *
 *   Nothing outside this directory may name a model or import a vendor SDK.
 *   Model choice is configuration.
 *
 *   Tool use is first class, not a capability flag. Harbor's design is that
 *   models reach data through tools rather than through pre-packed context, so
 *   a provider that cannot call tools cannot serve the main path.
 *
 * A local model behind an OpenAI-compatible endpoint implements this same
 * interface with a different base URL, which is the whole reason the routing
 * ladder is cheap to build later.
 */
import { ConfigurationError, UpstreamError } from "../kernel/errors.js";
import type { JsonSchema } from "./schemas.js";

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  readonly role: "user" | "assistant";
  readonly content: string | readonly ContentBlock[];
}

export interface CompletionRequest {
  readonly system?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly maxTokens?: number;
  /**
   * The shape the reply must take.
   *
   * Where a provider supports constrained decoding, this stops being a
   * description and becomes an enforcement: the sampler cannot emit a token
   * that breaks the schema, so a malformed reply is impossible rather than
   * handled. Providers that do not support it ignore this, and the post-hoc
   * repair in `json.ts` covers them exactly as it did before.
   */
  readonly schema?: JsonSchema | undefined;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CompletionResult {
  readonly provider: string;
  readonly model: string;
  readonly content: readonly ContentBlock[];
  readonly stopReason: string;
  readonly usage: TokenUsage;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicResponse {
  readonly model: string;
  readonly stop_reason: string;
  readonly content: readonly ContentBlock[];
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

export function anthropicProvider(modelOverride?: string): Provider {
  const key = process.env["ANTHROPIC_API_KEY"];

  if (key === undefined || key.length === 0) {
    throw new ConfigurationError(
      "ANTHROPIC_API_KEY is not set",
      "Put it in ~/.harbor/.env",
    );
  }

  const model = modelOverride ?? process.env["HARBOR_MODEL"] ?? DEFAULT_MODEL;

  return {
    id: "anthropic",
    model,

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const response = await fetch(ANTHROPIC_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(request.system === undefined ? {} : { system: request.system }),
          messages: request.messages,
          ...(request.tools === undefined ? {} : { tools: request.tools }),
        }),
      });

      const text = await response.text();

      if (!response.ok) {
        throw new UpstreamError(
          `Anthropic API returned ${String(response.status)}: ${text}`,
          {
            status: response.status,
            hint:
              response.status === 404
                ? `Model "${model}" was not found. Set HARBOR_MODEL to a model your key can reach.`
                : response.status === 401
                  ? "The API key was rejected."
                  : undefined,
          },
        );
      }

      const parsed = JSON.parse(text) as AnthropicResponse;

      return {
        provider: "anthropic",
        model: parsed.model,
        content: parsed.content,
        stopReason: parsed.stop_reason,
        usage: {
          inputTokens: parsed.usage.input_tokens,
          outputTokens: parsed.usage.output_tokens,
        },
      };
    },
  };
}
