/**
 * The advertised tool list, byte for byte.
 *
 * What a host sees from `tools/list` is the contract: the names, titles,
 * descriptions, input and output schemas, annotations and their order. A
 * client caches it, a model is prompted with it, a directory reviews it. This
 * pins the whole list as the wire carries it, read through a real SDK client
 * over an in-memory transport, so a refactor of where the definitions live
 * cannot change a byte of it unnoticed.
 *
 * Two sessions: a write-scoped one (every tool, read and write) and a
 * read-only one (the read registry alone, in its order).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

process.env.APP_URL = "http://localhost";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server";
import type { McpAuthContext } from "../auth";

function context(canWrite: boolean): McpAuthContext {
  return {
    userId: "u-1",
    tokenId: "t-1",
    scopes: canWrite ? ["health:read", "health:write"] : ["health:read"],
    binding: "u-1:t-1",
    canRead: true,
    canWrite,
  };
}

async function listTools(canWrite: boolean) {
  const server = createMcpServer(context(canWrite));
  const client = new Client({ name: "snapshot-test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

describe("the advertised MCP tool list", () => {
  it("is unchanged for a write-scoped session", async () => {
    const tools = await listTools(true);
    expect(tools.length).toBeGreaterThan(20);
    await expect(`${JSON.stringify(tools, null, 2)}\n`).toMatchFileSnapshot(
      "./__snapshots__/tools-list.write-session.snap",
    );
  });

  it("is unchanged for a read-only session", async () => {
    const tools = await listTools(false);
    expect(tools.length).toBeGreaterThan(20);
    await expect(
      `${JSON.stringify(
        tools.map((tool) => tool.name),
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot("./__snapshots__/tools-list.read-session.snap");
  });
});
