/**
 * The JSON Schema dialect `tools/list` advertises.
 *
 * The SDK converts every tool's Zod shape with a hard-coded draft-07 target and
 * stamps `"$schema": "http://json-schema.org/draft-07/schema#"` on each
 * `inputSchema` and `outputSchema`. Clients that validate with a 2020-12-only
 * validator refuse that dialect when the tool list arrives, so every tool is
 * unusable there, before a call ever reaches the server (#1170).
 *
 * This module re-renders each advertised schema from the same Zod shape with
 * the 2020-12 target (`$defs`, `prefixItems`, …) and drops the `$schema` key.
 * A schema without `$schema` is 2020-12 under the MCP spec, and a draft-07
 * client still compiles it, so omitting the key serves both. Everything else
 * the SDK puts on a tool entry is kept as it is.
 *
 * Only the advertised copy changes. The SDK validates `structuredContent`
 * against the Zod shape itself, never against this JSON, so result validation
 * is untouched. Prompts advertise an argument list rather than a schema, and
 * resource templates carry no schema, so tools are the whole surface.
 */
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  type ListToolsRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { McpToolDefinition } from "./tools";

type JsonSchemaObject = Record<string, unknown>;

/** Render one Zod raw shape as a 2020-12 schema with no `$schema` key. */
export function toAdvertisedJsonSchema(
  shape: z.ZodRawShape,
  io: "input" | "output",
): JsonSchemaObject {
  const rendered = z.toJSONSchema(z.object(shape), {
    target: "draft-2020-12",
    io,
  }) as JsonSchemaObject;
  delete rendered.$schema;
  return rendered;
}

type ListToolsHandler = (
  request: ListToolsRequest,
  extra: unknown,
) => Promise<ListToolsResult>;

/**
 * Wrap the SDK's `tools/list` handler so every advertised schema is 2020-12.
 * Call once, after every tool is registered. `tools` maps each registered name
 * to its definition; a listed tool missing from it is a wiring error and
 * throws rather than slipping through in the SDK's dialect.
 *
 * The SDK exposes no way to read its own handler, so it is taken from the
 * protocol's handler map. When no tool was registered there is no handler and
 * nothing to rewrite. `tool-schema-dialect.test.ts` reads the list through a
 * real client, so an SDK change that moves the map fails there.
 */
export function advertiseToolSchemasAs2020(
  server: McpServer,
  tools: ReadonlyMap<string, McpToolDefinition>,
): void {
  const handlers = (
    server.server as unknown as {
      _requestHandlers?: Map<string, ListToolsHandler>;
    }
  )._requestHandlers;
  const sdkList = handlers?.get("tools/list");
  if (!sdkList) return;

  server.server.setRequestHandler(
    ListToolsRequestSchema,
    async (request, extra) => {
      const result = await sdkList(request, extra);
      return {
        ...result,
        tools: result.tools.map((entry) => {
          const definition = tools.get(entry.name);
          if (!definition) {
            throw new Error(
              `tools/list: no definition registered for "${entry.name}"`,
            );
          }
          return {
            ...entry,
            inputSchema: toAdvertisedJsonSchema(
              definition.inputShape,
              "input",
            ) as ListToolsResult["tools"][number]["inputSchema"],
            ...(definition.outputShape
              ? {
                  outputSchema: toAdvertisedJsonSchema(
                    definition.outputShape,
                    "output",
                  ) as NonNullable<
                    ListToolsResult["tools"][number]["outputSchema"]
                  >,
                }
              : {}),
          };
        }),
      };
    },
  );
}
