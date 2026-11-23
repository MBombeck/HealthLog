/**
 * Migration 0512 gives the Local provider a model column of its own (#1417)
 * and fills it with the model the Local entry ran on until now, the shared
 * `ai_model`: for an account on Local, and for one that keeps a Local base URL
 * behind a provider that does not own `ai_model`. An account on OpenAI or
 * Anthropic keeps its model where it is and gets no Local model. `ai_model`
 * itself is left alone, so the previous image still finds it, and a rerun
 * changes nothing.
 *
 * The testcontainer applied the file on boot; the rows below are written with
 * an empty `ai_local_model`, the state the file finds on a real host, and the
 * file is run again over them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "prisma",
    "migrations",
    "0512_ai_local_model",
    "migration.sql",
  ),
  "utf8",
);

const LAN = "http://ollama.lan:11434/v1";

const ACCOUNTS = [
  { id: "m0512-local", aiProvider: "LOCAL", aiModel: "gemma3:27b", url: LAN },
  {
    id: "m0512-local-no-url",
    aiProvider: "LOCAL",
    aiModel: "qwen2.5",
    url: null,
  },
  {
    id: "m0512-gateway",
    aiProvider: "OPENAI_COMPATIBLE",
    aiModel: "llama3.1:8b",
    url: LAN,
  },
  {
    id: "m0512-gateway-no-url",
    aiProvider: "OPENAI_COMPATIBLE",
    aiModel: "cloud-model",
    url: null,
  },
  { id: "m0512-openai", aiProvider: "OPENAI", aiModel: "gpt-4o", url: LAN },
  {
    id: "m0512-anthropic",
    aiProvider: "ANTHROPIC",
    aiModel: "claude-sonnet-4-6",
    url: LAN,
  },
  { id: "m0512-blank", aiProvider: "LOCAL", aiModel: "  ", url: LAN },
] as const;

async function localModels(): Promise<Record<string, string | null>> {
  const rows = await prisma.user.findMany({
    where: { id: { startsWith: "m0512-" } },
    select: { id: true, aiLocalModel: true },
  });
  return Object.fromEntries(rows.map((r) => [r.id, r.aiLocalModel]));
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  for (const account of ACCOUNTS) {
    await prisma.user.create({
      data: {
        id: account.id,
        username: account.id,
        aiProvider: account.aiProvider,
        aiModel: account.aiModel,
        aiLocalBaseUrl: account.url,
      },
    });
  }
  await prisma.$executeRawUnsafe(MIGRATION);
});

// One walk by design: the state the file left, then a Local model set since
// and the file run again over it. The rerun case changes the row the first
// case reads, so the block keeps its order under a shuffled run.
describe(
  "migration 0512 — the Local provider's own model",
  { shuffle: false },
  () => {
    it("copies the model the Local entry ran on, and only that", async () => {
      expect(await localModels()).toEqual({
        "m0512-local": "gemma3:27b",
        "m0512-local-no-url": "qwen2.5",
        // A Local base URL behind the gateway: the Local chain entry read the
        // shared model.
        "m0512-gateway": "llama3.1:8b",
        "m0512-gateway-no-url": null,
        // OpenAI and Anthropic own the shared model.
        "m0512-openai": null,
        "m0512-anthropic": null,
        "m0512-blank": null,
      });
    });

    it("leaves the shared model and Local's address where they were", async () => {
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: "m0512-local" },
        select: { aiModel: true, aiLocalBaseUrl: true },
      });
      expect(row).toEqual({ aiModel: "gemma3:27b", aiLocalBaseUrl: LAN });
    });

    it("changes nothing on a rerun, a Local model set since included", async () => {
      await prisma.user.update({
        where: { id: "m0512-local" },
        data: { aiLocalModel: "picked-later" },
      });
      const before = await localModels();
      await prisma.$executeRawUnsafe(MIGRATION);
      expect(await localModels()).toEqual(before);
      expect(before["m0512-local"]).toBe("picked-later");
    });
  },
);
