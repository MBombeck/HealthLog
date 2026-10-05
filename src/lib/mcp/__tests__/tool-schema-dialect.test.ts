/**
 * Guard: every schema `tools/list` advertises is valid JSON Schema 2020-12.
 *
 * The SDK converts each Zod shape with a hard-coded draft-07 target, so every
 * `inputSchema` and `outputSchema` used to carry
 * `"$schema": "http://json-schema.org/draft-07/schema#"`. A client that
 * validates with a 2020-12-only allowlist refuses the dialect at registration
 * and every tool becomes unusable (#1170). The server now advertises 2020-12
 * with no `$schema` key — the MCP default dialect — so a strict client and a
 * draft-07 client both accept it.
 *
 * The list is read through a real SDK client over an in-memory transport, so
 * the assertion is on the wire, not on the registry. A write-scoped session is
 * used so the write tools are covered too.
 */
import { describe, it, expect, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

process.env.APP_URL = "http://localhost";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server";
import { MCP_TOOLS } from "../tools";
import { MCP_WRITE_TOOLS } from "../write-tools";
import type { McpAuthContext } from "../auth";

const ctx: McpAuthContext = {
  userId: "u-1",
  tokenId: "t-1",
  scopes: ["health:read", "health:write"],
  binding: "u-1:t-1",
  canRead: true,
  canWrite: true,
};

async function listTools() {
  const server = createMcpServer(ctx);
  const client = new Client({ name: "dialect-test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

/** Every draft-07-only construct, anywhere in a schema tree. */
function draft07Constructs(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => draft07Constructs(v, `${path}[${i}]`));
  }
  if (!node || typeof node !== "object") return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    const at = `${path}.${key}`;
    if (
      key === "$schema" &&
      value !== "https://json-schema.org/draft/2020-12/schema"
    ) {
      found.push(`${at} = ${String(value)}`);
    }
    if (key === "definitions") found.push(at);
    if (key === "dependencies") found.push(at);
    if (key === "additionalItems") found.push(at);
    if (key === "items" && Array.isArray(value)) found.push(`${at} (array)`);
    if (
      key === "$ref" &&
      typeof value === "string" &&
      value.includes("/definitions/")
    ) {
      found.push(`${at} = ${value}`);
    }
    found.push(...draft07Constructs(value, at));
  }
  return found;
}

describe("tools/list advertises JSON Schema 2020-12", () => {
  it("advertises every read and write tool", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...MCP_TOOLS, ...MCP_WRITE_TOOLS].map((t) => t.name).sort(),
    );
  });

  it("carries no draft-07 marker or construct anywhere", async () => {
    const tools = await listTools();
    expect(JSON.stringify(tools)).not.toContain("draft-07");
    const offenders = tools.flatMap((tool) => [
      ...draft07Constructs(tool.inputSchema, `${tool.name}.inputSchema`),
      ...(tool.outputSchema
        ? draft07Constructs(tool.outputSchema, `${tool.name}.outputSchema`)
        : []),
    ]);
    expect(offenders).toEqual([]);
  });

  it("compiles every input and output schema under a 2020-12 validator", async () => {
    const tools = await listTools();
    const ajv = new Ajv2020({ strict: false, validateSchema: true });
    let compiled = 0;
    for (const tool of tools) {
      for (const [kind, schema] of [
        ["inputSchema", tool.inputSchema],
        ["outputSchema", tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        expect(
          ajv.validateSchema(schema),
          `${tool.name}.${kind}: ${ajv.errorsText()}`,
        ).toBe(true);
        expect(() => ajv.compile(schema), `${tool.name}.${kind}`).not.toThrow();
        compiled++;
      }
    }
    // Every tool has an inputSchema, and the surface declares output shapes;
    // a count of zero would mean the loop above proved nothing.
    expect(compiled).toBeGreaterThan(tools.length);
  });
});
