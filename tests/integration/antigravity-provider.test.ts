/**
 * Antigravity in the provider chain, against the real database and a real
 * (fake) `agy` process.
 *
 * `resolveProviderChain` reads the user's stored chain, profile and model. The
 * Antigravity hop is kept only when the profile folder exists on the server.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolveProviderChain } from "@/lib/ai/provider";
import { singleUserTurn } from "@/lib/ai/types";

import { getPrismaClient, truncateAllTables } from "./setup";
import { installFakeAgy, type FakeAgy } from "./antigravity-fake-agy";

const AGY_CHAIN = [{ providerType: "antigravity", priority: 1, enabled: true }];

let counter = 0;

async function makeUser(opts: {
  profileId: string | null;
  model?: string | null;
  chain?: unknown;
}) {
  const suffix = counter++;
  return getPrismaClient().user.create({
    data: {
      username: `agy-${suffix}`,
      email: `agy-${suffix}@example.test`,
      timezone: "UTC",
      aiProviderChain: opts.chain ?? AGY_CHAIN,
      antigravityProfileId: opts.profileId,
      antigravityModel: opts.model ?? null,
      antigravityConnectionStatus: opts.profileId
        ? "connected"
        : "disconnected",
    },
  });
}

describe("Antigravity provider chain (database and fake agy)", () => {
  let fake: FakeAgy;

  beforeAll(() => {
    fake = installFakeAgy();
    mkdirSync(path.join(fake.profileRoot, "prof-ready"));
  });

  afterAll(() => {
    fake.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(getPrismaClient());
    fake.reset();
  });

  it("keeps Antigravity in the chain when the user's profile folder exists", async () => {
    const user = await makeUser({ profileId: "prof-ready" });

    const chain = await resolveProviderChain(user.id);

    expect(chain.map((entry) => entry.providerType)).toEqual(["antigravity"]);
    expect(chain[0].instance.type).toBe("antigravity");
    expect(chain[0].instance.supportsTools).toBe(false);
  });

  it("drops Antigravity from the chain when the profile folder is missing", async () => {
    const user = await makeUser({ profileId: "prof-not-created" });

    const chain = await resolveProviderChain(user.id);

    expect(chain.map((entry) => entry.providerType)).not.toContain(
      "antigravity",
    );
  });

  it("drops Antigravity from the chain when the user has no profile", async () => {
    const user = await makeUser({ profileId: null });

    const chain = await resolveProviderChain(user.id);

    expect(chain.map((entry) => entry.providerType)).not.toContain(
      "antigravity",
    );
  });

  it("sends the user's saved model to the CLI, and the reply comes from their profile", async () => {
    const user = await makeUser({
      profileId: "prof-ready",
      model: "model-pro",
    });

    const chain = await resolveProviderChain(user.id);
    const result = await chain[0].instance.generateCompletion(
      singleUserTurn({ system: "Be brief.", user: "Hello" }),
    );

    expect(result.content).toBe("profile:prof-ready");
    expect(result.model).toBe("model-pro");
    expect(fake.records()).toContainEqual({
      kind: "model",
      value: "model-pro",
    });
  });
});
