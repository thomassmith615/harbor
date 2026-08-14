/**
 * The MCP surface.
 *
 * JSON-RPC over stdio, exposing exactly the tool surface the ask loop already
 * uses. That is the point: Claude Desktop and Claude Code become clients of the
 * same gated, principal-scoped, audited retrieval path, with no second
 * implementation to keep in step.
 *
 * Write actions are exposed as `propose_action` only. An MCP client can ask for
 * something to happen; it cannot make it happen. Approval stays with a human at
 * a surface that human chose.
 */
import { createInterface } from "node:readline";
import { runTool, TOOLS } from "../reasoning/tools.js";
import { createEmbedder } from "../derive/embed/index.js";
import type { DB } from "../kernel/db.js";
import type { Embedder } from "../derive/embed/index.js";

const PROTOCOL_VERSION = "2024-11-05";

interface Request {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface McpOptions {
  readonly principalId: string;
  readonly timezone: string;
}


export async function serveMcp(db: DB, options: McpOptions): Promise<void> {
  let embedder: Embedder | undefined;

  try {
    embedder = await createEmbedder();
  } catch {
    embedder = undefined;
  }

  const context = {
    principal: options.principalId,
    timezone: options.timezone,
    ...(embedder === undefined ? {} : { embedder }),
  };

  const send = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const reply = (id: number | string | undefined, result: unknown): void => {
    if (id === undefined) {
      return;
    }
    send({ jsonrpc: "2.0", id, result });
  };

  const fail = (id: number | string | undefined, code: number, message: string): void => {
    if (id === undefined) {
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const readline = createInterface({ input: process.stdin });

  for await (const line of readline) {
    if (line.trim().length === 0) {
      continue;
    }

    let request: Request;

    try {
      request = JSON.parse(line) as Request;
    } catch {
      continue;
    }

    if (request.method === "initialize") {
      reply(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "harbor", version: "0.10.0" },
      });
      continue;
    }

    if (request.method === "notifications/initialized" || request.method === "ping") {
      reply(request.id, {});
      continue;
    }

    if (request.method === "tools/list") {
      reply(request.id, {
        tools: [
          ...TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input_schema,
          })),
        ],
      });
      continue;
    }

    if (request.method === "tools/call") {
      const name = request.params?.["name"];
      const args = (request.params?.["arguments"] ?? {}) as Record<string, unknown>;

      if (typeof name !== "string") {
        fail(request.id, -32602, "name is required");
        continue;
      }

      try {
        const outcome = await runTool(db, context, { name, input: args });

        reply(request.id, {
          content: [{ type: "text", text: outcome.content }],
          isError: outcome.isError,
        });
      } catch (error: unknown) {
        fail(request.id, -32603, error instanceof Error ? error.message : String(error));
      }

      continue;
    }

    fail(request.id, -32601, `unknown method ${request.method}`);
  }
}
