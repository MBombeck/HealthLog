import type { z } from "zod/v4";

import type { McpAuthContext } from "../auth";

/**
 * Tool annotations (MCP 2025-11-25). The cloud connectors REQUIRE these on every
 * tool — the ChatGPT Apps SDK treats an omitted hint as a validation error, and
 * the Claude directory requires a safety hint per tool. Every tool the MCP
 * surface exposes is read-only over a closed personal record, so they all share
 * the same shape (ADR-003): the read-only guarantee is structural, the
 * annotation merely advertises it.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * A registry entry. `inputShape` is a zod/v4 raw shape handed straight to the
 * SDK's `registerTool` for argument validation; `run` receives the validated
 * arguments and the session context and returns a plain structured object.
 */
export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputShape: z.ZodRawShape;
  /** Tool annotations — mandatory for the cloud connectors (see above). */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /**
   * When set, the tool declares a structured `outputSchema` and its result is
   * returned as `structuredContent`. Used by `search` / `fetch` so ChatGPT can
   * consume the exact `{id,title,url}[]` / `{id,title,text,url,metadata}` shapes.
   */
  outputShape?: z.ZodRawShape;
  run: (ctx: McpAuthContext, args: Record<string, unknown>) => Promise<unknown>;
}
