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
const DEFAULT_MODEL = "llama3.2:3b";
const DEFAULT_LARGE_MODEL = "qwen3:14b";

/**
 * Which local model a tier uses, in one place.
 *
 * There were three places, reading three different environment variables, and
 * the result was exactly what you would expect: `harbor dev preflight` reported
 * that `llama3.2:3b` returned clean JSON while extraction ran fifty items
 * against `qwen3:4b` and rejected every one. Two commands, two answers, one
 * machine, and nothing wrong with either piece of code on its own.
 *
 * `HARBOR_LOCAL_MODEL` is the name to know; the tier-specific ones still work
 * for anyone who set them. Whatever this returns is what actually gets called,
 * because everything that needs to know now asks here.
 */
export function localModelFor(tier: "small" | "large"): string {
  const shared = process.env["HARBOR_LOCAL_MODEL"];

  if (shared !== undefined && shared.length > 0) {
    return shared;
  }

  const specific =
    tier === "small" ? process.env["HARBOR_LOCAL_SMALL"] : process.env["HARBOR_LOCAL_LARGE"];

  if (specific !== undefined && specific.length > 0) {
    return specific;
  }

  return tier === "small" ? DEFAULT_MODEL : DEFAULT_LARGE_MODEL;
}

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
  const name = model ?? localModelFor("small");

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
            // Generous, because a model that reasons spends its budget before
            // it answers and the symptom is an empty reply rather than an
            // error. Fifty extractions came back as "the model said nothing"
            // for exactly this reason.
            max_tokens: request.maxTokens ?? 2_048,
            stream: false,
            // Reasoning off, wherever the server understands the ask.
            //
            // Most capable small models released recently think out loud before
            // answering, and the default here was one of them. Every structured
            // extraction came back as a `<think>` block followed by the answer,
            // so 43 of 50 failed to parse and the pass recorded nothing. It also
            // spent roughly 28 seconds per item generating reasoning nobody read.
            //
            // Three spellings because three servers disagree: Ollama, llama.cpp
            // and LM Studio each named it differently. A server that does not
            // recognise one ignores it, and `reasoning/json.ts` handles what
            // gets through anyway, because the caller cannot depend on this.
            think: false,
            enable_thinking: false,
            chat_template_kwargs: { enable_thinking: false },
            // Constrained decoding, in the three spellings that cover the
            // servers people actually run.
            //
            // `format` is Ollama's, and it takes a JSON schema directly.
            // `response_format` is the OpenAI shape, which LM Studio and recent
            // llama.cpp builds accept. `json_schema` at the top level is
            // llama.cpp's own. A server ignores the keys it does not know, so
            // sending all three costs a few bytes and covers every setup
            // without probing for one.
            //
            // What this changes: a reply that violates the schema stops being
            // something `json.ts` has to repair and becomes something the
            // sampler cannot produce. The repair path stays, because an older
            // server will ignore all three of these and behave exactly as it
            // did before.
            ...(request.schema === undefined
              ? {}
              : {
                  format: request.schema,
                  json_schema: request.schema,
                  response_format: {
                    type: "json_schema",
                    json_schema: { name: "harbor", strict: false, schema: request.schema },
                  },
                }),
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
